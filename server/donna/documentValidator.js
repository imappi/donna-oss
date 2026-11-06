// Accounting validators — deterministic checks per document family.
//
// Each validator is a pure function that takes the extraction output
// and returns machine-actionable outcomes with severity codes.
//
// Severity semantics:
//   info       — logged for audit, no downstream effect
//   warn       — blocks auto-explain, match stays 'suggested'
//   block_auto — blocks auto-match entirely, enters review queue
//
// Outcomes land on `parse_summary.validation_outcomes[]`.
// Workflow gates consume severity codes, not string-matching on
// warning text.

import { toIsoDay, toUtcDayMs } from './dates.js';
import { validateReceiptTotals } from './totalsValidation.js';

const numeric = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const TOLERANCE_AMOUNT = 1;
const TOLERANCE_PCT = 0.02;

// ── Totals: ONE formula (RT-04, finding F-05) ───────────────────────
//
// The invoice/bill and receipt validators do not own a totals equation.
// They hand the numbers to `validateReceiptTotals` (totalsValidation.js —
// discount/shipping/rounding-aware, tax-inclusive AND tax-exclusive
// roll-ups) and turn its receipt into an outcome. Before RT-04 this file
// carried its own `subtotal + tax` copy, which flagged every discounted
// bill (Social DXB: 550 + 27.50 − 27.50 = 550 "failed" by 27.50) and was
// laundered into the same 'amount_mismatch' token the review-row writer
// keys on. The receipt rides on the outcome as `totals` so the worker
// persists it (`parse_summary.totals_validation`) without recomputing.
//
// The header is read first: the repair / filename passes fill
// `header.total_amount` after the extractor mapper ran, and the summary
// copy can lag behind it. A total is never changed once present, only
// filled — so the extractor-time verdict is either the same as this one
// or a `no_total` no-opinion this one supersedes.
const totalsInputFrom = (header = {}, summary = {}) => ({
  ...summary,
  total_amount: header.total_amount ?? summary.total_amount ?? null,
  tax_amount: header.tax_amount ?? summary.tax_amount ?? null
});

const totalsOutcomeFor = ({ totals, prefix, mismatchFields }) => {
  // No opinion (no total printed, nothing to sum) → no outcome. Absence
  // of a totals outcome means "not evaluated", never "reconciled".
  if (totals.reason !== null) return null;
  const drift = Math.abs(totals.drift).toFixed(2);
  if (totals.matches) {
    return {
      code: `${prefix}_TOTAL_RECONCILED`,
      severity: 'info',
      message: `expected ${totals.expected} (${totals.strategy}, ${totals.basis}) = total ${totals.total} within tolerance (drift ${drift})`,
      affected_fields: ['total_amount'],
      passed: true,
      totals
    };
  }
  return {
    code: `${prefix}_TOTAL_MISMATCH`,
    severity: 'warn',
    message: `expected ${totals.expected} (${totals.strategy}, ${totals.basis}), but total is ${totals.total} (drift ${drift})`,
    affected_fields: mismatchFields,
    passed: false,
    totals
  };
};

// ── Invoice / Bill Validator ────────────────────────────────────────

export const validateInvoiceBill = ({ header = {}, summary = {}, lines = [] } = {}) => {
  const outcomes = [];

  const total = numeric(header.total_amount, null);
  const subtotal = numeric(summary.subtotal_amount, null);
  const currency = header.currency || summary.currency || null;

  const totalsOutcome = totalsOutcomeFor({
    totals: validateReceiptTotals({ summary: totalsInputFrom(header, summary), lines }),
    prefix: 'INVOICE',
    mismatchFields: ['total_amount', 'subtotal_amount', 'tax_amount', 'lines']
  });
  if (totalsOutcome) outcomes.push(totalsOutcome);

  if (Array.isArray(lines) && lines.length > 0 && subtotal !== null) {
    const lineSum = lines.reduce((acc, l) => acc + numeric(l?.amount, 0), 0);
    const drift = Math.abs(lineSum - subtotal);
    if (drift > TOLERANCE_AMOUNT && drift / Math.max(Math.abs(subtotal), 0.01) > TOLERANCE_PCT) {
      outcomes.push({
        code: 'INVOICE_LINE_SUM_MISMATCH',
        severity: 'warn',
        message: `sum(lines) = ${lineSum.toFixed(2)}, subtotal = ${subtotal} (drift ${drift.toFixed(2)})`,
        affected_fields: ['subtotal_amount', 'lines'],
        passed: false
      });
    }
  }

  if (total !== null) {
    const amountDue = numeric(summary.amount_due ?? header.total_amount, null);
    if (amountDue !== null && amountDue > total * 1.01 + TOLERANCE_AMOUNT) {
      outcomes.push({
        code: 'INVOICE_AMOUNT_DUE_EXCEEDS_TOTAL',
        severity: 'warn',
        message: `amount_due (${amountDue}) exceeds total (${total})`,
        affected_fields: ['total_amount'],
        passed: false
      });
    }
  }

  if (currency) {
    const lineCurrencies = (lines || [])
      .map((l) => l?.currency)
      .filter((c) => c && typeof c === 'string');
    const mismatch = lineCurrencies.find(
      (c) => c.toUpperCase() !== currency.toUpperCase()
    );
    if (mismatch) {
      outcomes.push({
        code: 'INVOICE_CURRENCY_INCONSISTENT',
        severity: 'block_auto',
        message: `header currency ${currency} but line has ${mismatch}`,
        affected_fields: ['currency'],
        passed: false
      });
    }
  }

  if (header.reference_number) {
    outcomes.push({
      code: 'INVOICE_REFERENCE_PRESENT',
      severity: 'info',
      message: 'invoice/bill reference number extracted',
      affected_fields: ['reference_number'],
      passed: true
    });
  }

  return outcomes;
};

// ── Receipt Validator ───────────────────────────────────────────────

export const validateReceipt = ({ header = {}, summary = {}, lines = [] } = {}) => {
  const outcomes = [];

  // Receipt totals are judged only when there are lines to reconcile —
  // the gating this validator always had. (validateInvoiceBill also judges
  // a header-only bill against its printed subtotal, as it always did; the
  // formula is shared, the entry conditions are each validator's own. RT-04
  // stops false positives and does not add a review-row source — RT-10
  // owns when a row is written.)
  if (Array.isArray(lines) && lines.length > 0) {
    const totalsOutcome = totalsOutcomeFor({
      totals: validateReceiptTotals({ summary: totalsInputFrom(header, summary), lines }),
      prefix: 'RECEIPT',
      mismatchFields: ['total_amount', 'lines']
    });
    if (totalsOutcome) outcomes.push(totalsOutcome);
  }

  if (header.document_date) {
    const docDate = new Date(header.document_date + 'T00:00:00Z');
    const now = Date.now();
    if (!Number.isNaN(docDate.getTime()) && docDate.getTime() > now + 86400000 * 7) {
      outcomes.push({
        code: 'RECEIPT_DATE_IN_FUTURE',
        severity: 'warn',
        message: `document_date ${header.document_date} is more than 7 days in the future`,
        affected_fields: ['document_date'],
        passed: false
      });
    }
  }

  return outcomes;
};

// ── Settlement Statement Validator (RT-21b) ─────────────────────────
//
// A payout statement that LISTS several settlements carries them as
// `summary.settlement.rows` with the extractor's footing receipt
// (`rows_validation`: Σ row nets against the statement net, one cent per
// row). The outcome is the RECEIPT_TOTAL_RECONCILED precedent applied to
// rows: reconciled ⇒ info (the rows ARE the document lines, one per row at
// its net, and RT-21c may settle them one bank credit each); mismatch ⇒
// warn (the statement is `partial`, the breakdown lines stand, the rows are
// evidence only). No opinion when the statement lists no rows.
export const validateSettlementStatement = ({ summary = {} } = {}) => {
  const outcomes = [];
  const receipt = summary?.settlement?.rows_validation;
  if (!receipt || typeof receipt !== 'object') return outcomes;
  const drift = receipt.drift == null ? 'n/a' : Math.abs(Number(receipt.drift)).toFixed(2);
  if (receipt.matches) {
    outcomes.push({
      code: 'SETTLEMENT_ROWS_RECONCILED',
      severity: 'info',
      message: `${receipt.row_count} settlement rows sum to ${receipt.total} = statement net ${receipt.expected} within tolerance (drift ${drift})`,
      affected_fields: ['lines'],
      passed: true,
      rows: receipt
    });
  } else {
    outcomes.push({
      code: 'SETTLEMENT_ROWS_MISMATCH',
      severity: 'warn',
      message: receipt.reason === 'row_net_missing'
        ? `${receipt.rows_missing_net} of ${receipt.row_count} settlement rows print no net`
        : receipt.reason === 'statement_net_missing'
          ? `${receipt.row_count} settlement rows but no statement net to foot against`
          : `${receipt.row_count} settlement rows sum to ${receipt.total}, but the statement net is ${receipt.expected} (drift ${drift})`,
      affected_fields: ['lines', 'total_amount'],
      passed: false,
      rows: receipt
    });
  }
  return outcomes;
};

// ── Bank Statement Validator ────────────────────────────────────────

export const validateBankStatement = ({ summary = {}, transactions = [] } = {}) => {
  const outcomes = [];

  const opening = numeric(summary.opening_balance, null);
  const closing = numeric(summary.closing_balance, null);

  if (opening !== null && closing !== null && transactions.length > 0) {
    let runningBalance = opening;
    for (const tx of transactions) {
      const signed = numeric(tx?.signed_amount ?? tx?.amount, 0);
      if (signed !== 0) {
        runningBalance += signed;
      } else {
        const credit = numeric(tx?.credit ?? tx?.money_in, 0);
        const debit = numeric(tx?.debit ?? tx?.money_out, 0);
        runningBalance += credit - debit;
      }
    }

    const drift = Math.abs(runningBalance - closing);
    if (drift > TOLERANCE_AMOUNT) {
      outcomes.push({
        code: 'STATEMENT_BALANCE_MISMATCH',
        severity: 'block_auto',
        message: `opening (${opening}) + transactions = ${runningBalance.toFixed(2)}, expected closing ${closing} (drift ${drift.toFixed(2)})`,
        affected_fields: ['opening_balance', 'closing_balance'],
        passed: false
      });
    } else {
      outcomes.push({
        code: 'STATEMENT_BALANCE_RECONCILED',
        severity: 'info',
        message: 'opening + transactions = closing within tolerance',
        affected_fields: ['opening_balance', 'closing_balance'],
        passed: true
      });
    }
  }

  const periodStart = summary.period_start_date || summary.period_start || null;
  const periodEnd = summary.period_end_date || summary.period_end || null;

  if (periodStart && periodEnd) {
    const startMs = toUtcDayMs(periodStart);
    const endMs = toUtcDayMs(periodEnd);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      let outsidePeriod = 0;
      for (const tx of transactions) {
        const txDateRaw = tx?.transaction_date || tx?.posted_date || tx?.date;
        if (!txDateRaw) continue;
        const txMs = toUtcDayMs(txDateRaw);
        if (!Number.isFinite(txMs)) continue;
        if (txMs < startMs || txMs > endMs) outsidePeriod++;
      }
      if (outsidePeriod > 0) {
        outcomes.push({
          code: 'STATEMENT_DATES_OUTSIDE_PERIOD',
          severity: 'warn',
          message: `${outsidePeriod} transaction(s) have dates outside period ${toIsoDay(periodStart)} to ${toIsoDay(periodEnd)}`,
          affected_fields: ['period_start', 'period_end'],
          passed: false
        });
      }
    }
  }

  return outcomes;
};

// ── Evidence Document Validator ─────────────────────────────────────
// Evidence documents (generic/unknown) don't have strict accounting
// rules. Produce info-level outcomes only.

export const validateEvidenceDocument = ({ header = {}, summary = {} } = {}) => {
  const outcomes = [];

  if (header.total_amount != null) {
    outcomes.push({
      code: 'EVIDENCE_AMOUNT_EXTRACTED',
      severity: 'info',
      message: 'amount extracted from evidence document',
      affected_fields: ['total_amount'],
      passed: true
    });
  }

  if (header.vendor_name) {
    outcomes.push({
      code: 'EVIDENCE_VENDOR_EXTRACTED',
      severity: 'info',
      message: 'vendor extracted from evidence document',
      affected_fields: ['vendor_name'],
      passed: true
    });
  }

  return outcomes;
};

// ── Contract Validator ──────────────────────────────────────────────

export const validateContract = ({ header = {}, summary = {} } = {}) => {
  const outcomes = [];

  const effectiveDate = summary.effective_start_date || summary.effective_date || header.document_date;
  const expiryDate = summary.effective_end_date || summary.expiry_date;

  if (effectiveDate && expiryDate) {
    const start = new Date(effectiveDate + 'T00:00:00Z');
    const end = new Date(expiryDate + 'T00:00:00Z');
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end < start) {
      outcomes.push({
        code: 'CONTRACT_DATES_INVERTED',
        severity: 'warn',
        message: `expiry_date ${expiryDate} is before effective_date ${effectiveDate}`,
        affected_fields: ['effective_date', 'expiry_date'],
        passed: false
      });
    }
  }

  const obligations = Array.isArray(summary.obligations) ? summary.obligations : [];
  for (let i = 0; i < obligations.length; i++) {
    const ob = obligations[i];
    if (ob.start_date && ob.end_date) {
      const obStart = new Date(ob.start_date + 'T00:00:00Z');
      const obEnd = new Date(ob.end_date + 'T00:00:00Z');
      if (!Number.isNaN(obStart.getTime()) && !Number.isNaN(obEnd.getTime()) && obEnd < obStart) {
        outcomes.push({
          code: 'OBLIGATION_DATES_INCOHERENT',
          severity: 'warn',
          message: `obligation[${i}] end_date ${ob.end_date} precedes start_date ${ob.start_date}`,
          affected_fields: ['obligations'],
          passed: false
        });
      }
    }
    if (ob.end_date && effectiveDate) {
      const obEnd = new Date(ob.end_date + 'T00:00:00Z');
      const contractStart = new Date(effectiveDate + 'T00:00:00Z');
      if (!Number.isNaN(obEnd.getTime()) && !Number.isNaN(contractStart.getTime()) && obEnd < contractStart) {
        outcomes.push({
          code: 'OBLIGATION_ENDS_BEFORE_CONTRACT',
          severity: 'warn',
          message: `obligation[${i}] end_date ${ob.end_date} is before contract effective_date ${effectiveDate}`,
          affected_fields: ['obligations', 'effective_date'],
          passed: false
        });
      }
    }
    if (ob.amount !== null && ob.amount !== undefined && ob.amount < 0) {
      outcomes.push({
        code: 'OBLIGATION_NEGATIVE_AMOUNT',
        severity: 'warn',
        message: `obligation[${i}] has negative amount ${ob.amount}`,
        affected_fields: ['obligations'],
        passed: false
      });
    }
    if (ob.currency && summary.currency && ob.currency.toUpperCase() !== summary.currency.toUpperCase()) {
      outcomes.push({
        code: 'OBLIGATION_CURRENCY_MISMATCH',
        severity: 'warn',
        message: `obligation[${i}] currency ${ob.currency} differs from contract currency ${summary.currency}`,
        affected_fields: ['obligations', 'currency'],
        passed: false
      });
    }
  }

  return outcomes;
};

// ── Dispatcher ──────────────────────────────────────────────────────
// Runs the appropriate validator based on document_type and returns
// structured outcomes.

export const validateDocument = ({ documentType, header, summary, lines, transactions } = {}) => {
  switch (documentType) {
    case 'supplier_bill':
    case 'sales_invoice':
      return validateInvoiceBill({ header, summary, lines });
    case 'receipt':
      return validateReceipt({ header, summary, lines });
    case 'bank_statement':
      return validateBankStatement({ summary, transactions });
    case 'contract':
      return validateContract({ header, summary });
    case 'payout_statement':
    case 'deposit_slip':
      return validateSettlementStatement({ summary });
    case 'generic_document':
    case 'entity_facts':
    case 'company_or_statutory_record':
      return validateEvidenceDocument({ header, summary });
    default:
      return [];
  }
};

// ── Severity helpers ────────────────────────────────────────────────

export const hasBlockAutoOutcome = (outcomes = []) =>
  outcomes.some((o) => o.severity === 'block_auto' && !o.passed);

export const hasWarnOutcome = (outcomes = []) =>
  outcomes.some((o) => o.severity === 'warn' && !o.passed);

export const outcomesToLegacyWarnings = (outcomes = []) => {
  const warnings = [];
  for (const o of outcomes) {
    if (o.passed) continue;
    if (o.code === 'INVOICE_TOTAL_MISMATCH' || o.code === 'RECEIPT_TOTAL_MISMATCH') {
      if (!warnings.includes('amount_mismatch')) warnings.push('amount_mismatch');
    }
    // INVOICE_LINE_SUM_MISMATCH (sum of lines ≠ printed subtotal) is a
    // DIFFERENT fact from "the totals do not foot" and deliberately maps to
    // no legacy token (RT-04, F-05): the review-row writer keys on
    // 'amount_mismatch' and a line-extraction miss must not open a
    // totals-do-not-reconcile row. The outcome itself stays on
    // parse_summary.validation_outcomes[].
    if (o.code === 'SETTLEMENT_ROWS_MISMATCH') {
      if (!warnings.includes('settlement_rows_mismatch')) warnings.push('settlement_rows_mismatch');
    }
    if (o.code === 'STATEMENT_BALANCE_MISMATCH') {
      if (!warnings.includes('balance_mismatch')) warnings.push('balance_mismatch');
    }
    if (o.code === 'RECEIPT_DATE_IN_FUTURE') {
      if (!warnings.includes('date_in_future')) warnings.push('date_in_future');
    }
    if (o.code === 'INVOICE_CURRENCY_INCONSISTENT') {
      if (!warnings.includes('currency_inconsistent')) warnings.push('currency_inconsistent');
    }
    if (o.code === 'STATEMENT_DATES_OUTSIDE_PERIOD') {
      if (!warnings.includes('dates_outside_period')) warnings.push('dates_outside_period');
    }
    if (o.code === 'CONTRACT_DATES_INVERTED') {
      if (!warnings.includes('dates_inverted')) warnings.push('dates_inverted');
    }
    if (o.code === 'OBLIGATION_DATES_INCOHERENT' || o.code === 'OBLIGATION_ENDS_BEFORE_CONTRACT') {
      if (!warnings.includes('obligation_dates_incoherent')) warnings.push('obligation_dates_incoherent');
    }
    if (o.code === 'OBLIGATION_NEGATIVE_AMOUNT') {
      if (!warnings.includes('obligation_negative_amount')) warnings.push('obligation_negative_amount');
    }
    if (o.code === 'OBLIGATION_CURRENCY_MISMATCH') {
      if (!warnings.includes('obligation_currency_mismatch')) warnings.push('obligation_currency_mismatch');
    }
  }
  return warnings;
};

// The totals receipt an outcome list carries (RT-04). The worker lifts it
// onto `parse_summary.totals_validation` after the post-repair validation
// pass, and the review-row writer copies it next to `reason_details`.
// null when the validators held no opinion (no total / nothing to sum) —
// the caller keeps whatever extractor-time receipt already exists.
export const totalsReceiptFromOutcomes = (outcomes = []) => {
  if (!Array.isArray(outcomes)) return null;
  const carrier = outcomes.find((o) => o && o.totals && typeof o.totals === 'object');
  return carrier ? carrier.totals : null;
};
