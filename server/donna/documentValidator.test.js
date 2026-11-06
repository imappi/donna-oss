import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateInvoiceBill,
  validateReceipt,
  validateBankStatement,
  validateEvidenceDocument,
  validateContract,
  validateSettlementStatement,
  validateDocument,
  hasBlockAutoOutcome,
  hasWarnOutcome,
  outcomesToLegacyWarnings,
  totalsReceiptFromOutcomes
} from './documentValidator.js';
import {
  TOTALS_TOLERANCE_CASES,
  TOTALS_NO_OPINION_CASES,
  headerForCase
} from './totalsValidation.cases.js';

let passed = 0;
let failed = 0;

const track = (t) => { t.then ? t.then(() => passed++) : passed++; };

// ── Invoice / Bill Validator ────────────────────────────────────────

track(test('invoice: subtotal + tax = total within tolerance → info', () => {
  const outcomes = validateInvoiceBill({
    header: { total_amount: 110, tax_amount: 10 },
    summary: { subtotal_amount: 100 }
  });
  const reconciled = outcomes.find((o) => o.code === 'INVOICE_TOTAL_RECONCILED');
  assert.ok(reconciled);
  assert.equal(reconciled.severity, 'info');
  assert.equal(reconciled.passed, true);
}));

track(test('invoice: subtotal + tax ≠ total → warn', () => {
  const outcomes = validateInvoiceBill({
    header: { total_amount: 130, tax_amount: 10 },
    summary: { subtotal_amount: 100 }
  });
  const mismatch = outcomes.find((o) => o.code === 'INVOICE_TOTAL_MISMATCH');
  assert.ok(mismatch);
  assert.equal(mismatch.severity, 'warn');
  assert.equal(mismatch.passed, false);
}));

track(test('invoice: sum(lines) ≠ subtotal → warn', () => {
  const outcomes = validateInvoiceBill({
    header: { total_amount: 110, tax_amount: 10 },
    summary: { subtotal_amount: 100 },
    lines: [{ amount: 50 }, { amount: 30 }]
  });
  const mismatch = outcomes.find((o) => o.code === 'INVOICE_LINE_SUM_MISMATCH');
  assert.ok(mismatch);
  assert.equal(mismatch.severity, 'warn');
}));

track(test('invoice: currency inconsistency → block_auto', () => {
  const outcomes = validateInvoiceBill({
    header: { total_amount: 100, currency: 'USD' },
    summary: {},
    lines: [{ amount: 100, currency: 'EUR' }]
  });
  const curr = outcomes.find((o) => o.code === 'INVOICE_CURRENCY_INCONSISTENT');
  assert.ok(curr);
  assert.equal(curr.severity, 'block_auto');
}));

track(test('invoice: reference present → info', () => {
  const outcomes = validateInvoiceBill({
    header: { total_amount: 100, reference_number: 'INV-001' },
    summary: {}
  });
  const ref = outcomes.find((o) => o.code === 'INVOICE_REFERENCE_PRESENT');
  assert.ok(ref);
  assert.equal(ref.severity, 'info');
}));

track(test('invoice: missing total and subtotal → empty outcomes', () => {
  const outcomes = validateInvoiceBill({ header: {}, summary: {} });
  const mismatch = outcomes.find((o) => o.code === 'INVOICE_TOTAL_MISMATCH');
  assert.equal(mismatch, undefined);
}));

// ── Receipt Validator ───────────────────────────────────────────────

track(test('receipt: lines reconcile with total → info', () => {
  const outcomes = validateReceipt({
    header: { total_amount: 30 },
    summary: { line_amounts_include_tax: true },
    lines: [{ amount: 20 }, { amount: 10 }]
  });
  const reconciled = outcomes.find((o) => o.code === 'RECEIPT_TOTAL_RECONCILED');
  assert.ok(reconciled);
  assert.equal(reconciled.passed, true);
}));

track(test('receipt: lines do not reconcile → warn', () => {
  const outcomes = validateReceipt({
    header: { total_amount: 50 },
    summary: { line_amounts_include_tax: true },
    lines: [{ amount: 20 }, { amount: 10 }]
  });
  const mismatch = outcomes.find((o) => o.code === 'RECEIPT_TOTAL_MISMATCH');
  assert.ok(mismatch);
  assert.equal(mismatch.severity, 'warn');
}));

track(test('receipt: tax-exclusive lines + tax = total → info', () => {
  const outcomes = validateReceipt({
    header: { total_amount: 33, tax_amount: 3 },
    summary: { line_amounts_include_tax: false },
    lines: [{ amount: 20 }, { amount: 10 }]
  });
  const reconciled = outcomes.find((o) => o.code === 'RECEIPT_TOTAL_RECONCILED');
  assert.ok(reconciled);
}));

track(test('receipt: date 30 days in future → warn', () => {
  const futureDate = new Date(Date.now() + 86400000 * 30);
  const dateStr = futureDate.toISOString().slice(0, 10);
  const outcomes = validateReceipt({
    header: { total_amount: 10, document_date: dateStr },
    summary: {},
    lines: []
  });
  const future = outcomes.find((o) => o.code === 'RECEIPT_DATE_IN_FUTURE');
  assert.ok(future);
  assert.equal(future.severity, 'warn');
}));

track(test('receipt: no lines → no mismatch outcome', () => {
  const outcomes = validateReceipt({
    header: { total_amount: 100 },
    summary: {},
    lines: []
  });
  assert.equal(outcomes.find((o) => o.code === 'RECEIPT_TOTAL_MISMATCH'), undefined);
}));

// ── Bank Statement Validator ────────────────────────────────────────

track(test('statement: opening + txns = closing → info', () => {
  const outcomes = validateBankStatement({
    summary: { opening_balance: 1000, closing_balance: 1150 },
    transactions: [
      { money_in: 200, money_out: 0 },
      { money_in: 0, money_out: 50 }
    ]
  });
  const reconciled = outcomes.find((o) => o.code === 'STATEMENT_BALANCE_RECONCILED');
  assert.ok(reconciled);
  assert.equal(reconciled.passed, true);
}));

track(test('statement: balance mismatch → block_auto', () => {
  const outcomes = validateBankStatement({
    summary: { opening_balance: 1000, closing_balance: 2000 },
    transactions: [{ money_in: 100, money_out: 0 }]
  });
  const mismatch = outcomes.find((o) => o.code === 'STATEMENT_BALANCE_MISMATCH');
  assert.ok(mismatch);
  assert.equal(mismatch.severity, 'block_auto');
}));

track(test('statement: signed_amount transactions reconcile', () => {
  const outcomes = validateBankStatement({
    summary: { opening_balance: 500, closing_balance: 650 },
    transactions: [
      { signed_amount: 200 },
      { signed_amount: -50 }
    ]
  });
  const reconciled = outcomes.find((o) => o.code === 'STATEMENT_BALANCE_RECONCILED');
  assert.ok(reconciled);
}));

track(test('statement: transactions outside period → warn', () => {
  const outcomes = validateBankStatement({
    summary: {
      opening_balance: 100,
      closing_balance: 100,
      period_start_date: '2026-01-01',
      period_end_date: '2026-01-31'
    },
    transactions: [
      { transaction_date: '2025-12-15', money_in: 0, money_out: 0 }
    ]
  });
  const outside = outcomes.find((o) => o.code === 'STATEMENT_DATES_OUTSIDE_PERIOD');
  assert.ok(outside);
  assert.equal(outside.severity, 'warn');
}));

// pg-Date regressions: node-postgres returns date columns as JS Date
// objects. Before the shared `toUtcDayMs` sweep, a Date tx date
// mangled to NaN and was silently skipped (false pass), and a Date
// period bound disabled the whole outside-period check.
track(test('statement: pg-Date transaction date outside period still detected', () => {
  const outcomes = validateBankStatement({
    summary: {
      opening_balance: 100,
      closing_balance: 100,
      period_start_date: '2026-01-01',
      period_end_date: '2026-01-31'
    },
    transactions: [
      { transaction_date: new Date('2025-12-15T00:00:00Z'), money_in: 0, money_out: 0 }
    ]
  });
  const outside = outcomes.find((o) => o.code === 'STATEMENT_DATES_OUTSIDE_PERIOD');
  assert.ok(outside, 'Date-object tx date must not be silently skipped');
}));

track(test('statement: pg-Date period bounds still enforce the window', () => {
  const outcomes = validateBankStatement({
    summary: {
      opening_balance: 100,
      closing_balance: 100,
      period_start_date: new Date('2026-01-01T00:00:00Z'),
      period_end_date: new Date('2026-01-31T00:00:00Z')
    },
    transactions: [
      { transaction_date: '2025-12-15', money_in: 0, money_out: 0 }
    ]
  });
  const outside = outcomes.find((o) => o.code === 'STATEMENT_DATES_OUTSIDE_PERIOD');
  assert.ok(outside, 'Date-object period bounds must not disable the check');
  assert.match(outside.message, /2026-01-01 to 2026-01-31/);
}));

track(test('statement: no balances → no balance outcome', () => {
  const outcomes = validateBankStatement({
    summary: {},
    transactions: [{ money_in: 100 }]
  });
  assert.equal(outcomes.find((o) => o.code === 'STATEMENT_BALANCE_MISMATCH'), undefined);
  assert.equal(outcomes.find((o) => o.code === 'STATEMENT_BALANCE_RECONCILED'), undefined);
}));

// ── Evidence Document Validator ─────────────────────────────────────

track(test('evidence: amount extracted → info', () => {
  const outcomes = validateEvidenceDocument({
    header: { total_amount: 500 }
  });
  const found = outcomes.find((o) => o.code === 'EVIDENCE_AMOUNT_EXTRACTED');
  assert.ok(found);
  assert.equal(found.severity, 'info');
}));

track(test('evidence: vendor extracted → info', () => {
  const outcomes = validateEvidenceDocument({
    header: { vendor_name: 'Acme' }
  });
  const found = outcomes.find((o) => o.code === 'EVIDENCE_VENDOR_EXTRACTED');
  assert.ok(found);
}));

track(test('evidence: empty header → no outcomes', () => {
  const outcomes = validateEvidenceDocument({ header: {} });
  assert.equal(outcomes.length, 0);
}));

// ── Contract Validator ──────────────────────────────────────────────

track(test('contract: inverted dates → warn', () => {
  const outcomes = validateContract({
    header: {},
    summary: { effective_date: '2026-12-01', expiry_date: '2026-01-01' }
  });
  const inverted = outcomes.find((o) => o.code === 'CONTRACT_DATES_INVERTED');
  assert.ok(inverted);
  assert.equal(inverted.severity, 'warn');
}));

track(test('contract: valid dates → no warning', () => {
  const outcomes = validateContract({
    header: {},
    summary: { effective_date: '2026-01-01', expiry_date: '2026-12-01' }
  });
  assert.equal(outcomes.find((o) => o.code === 'CONTRACT_DATES_INVERTED'), undefined);
}));

// ── Dispatcher ──────────────────────────────────────────────────────

track(test('validateDocument dispatches to invoice for supplier_bill', () => {
  const outcomes = validateDocument({
    documentType: 'supplier_bill',
    header: { total_amount: 130, tax_amount: 10 },
    summary: { subtotal_amount: 100 }
  });
  assert.ok(outcomes.find((o) => o.code === 'INVOICE_TOTAL_MISMATCH'));
}));

track(test('validateDocument dispatches to receipt', () => {
  const outcomes = validateDocument({
    documentType: 'receipt',
    header: { total_amount: 50 },
    summary: { line_amounts_include_tax: true },
    lines: [{ amount: 20 }]
  });
  assert.ok(outcomes.find((o) => o.code === 'RECEIPT_TOTAL_MISMATCH'));
}));

track(test('validateDocument returns empty for unknown type', () => {
  const outcomes = validateDocument({ documentType: 'payroll_cpf', header: {} });
  assert.equal(outcomes.length, 0);
}));

// ── Severity Helpers ────────────────────────────────────────────────

track(test('hasBlockAutoOutcome detects block_auto', () => {
  assert.equal(hasBlockAutoOutcome([
    { code: 'X', severity: 'block_auto', passed: false }
  ]), true);
  assert.equal(hasBlockAutoOutcome([
    { code: 'X', severity: 'warn', passed: false }
  ]), false);
  assert.equal(hasBlockAutoOutcome([
    { code: 'X', severity: 'block_auto', passed: true }
  ]), false);
}));

track(test('hasWarnOutcome detects warn', () => {
  assert.equal(hasWarnOutcome([
    { code: 'X', severity: 'warn', passed: false }
  ]), true);
  assert.equal(hasWarnOutcome([
    { code: 'X', severity: 'info', passed: false }
  ]), false);
}));

track(test('outcomesToLegacyWarnings maps codes to string tokens', () => {
  const warnings = outcomesToLegacyWarnings([
    { code: 'INVOICE_TOTAL_MISMATCH', severity: 'warn', passed: false },
    { code: 'RECEIPT_DATE_IN_FUTURE', severity: 'warn', passed: false },
    { code: 'INVOICE_TOTAL_RECONCILED', severity: 'info', passed: true }
  ]);
  assert.ok(warnings.includes('amount_mismatch'));
  assert.ok(warnings.includes('date_in_future'));
  assert.equal(warnings.length, 2);
}));

track(test('outcomesToLegacyWarnings: balance mismatch', () => {
  const warnings = outcomesToLegacyWarnings([
    { code: 'STATEMENT_BALANCE_MISMATCH', severity: 'block_auto', passed: false }
  ]);
  assert.ok(warnings.includes('balance_mismatch'));
}));

// ── Contract Obligation Validators ─────────────────────────────────

track(test('contract: obligation with inverted dates → OBLIGATION_DATES_INCOHERENT', () => {
  const outcomes = validateContract({
    header: {},
    summary: {
      effective_start_date: '2025-01-01',
      obligations: [
        { start_date: '2025-06-01', end_date: '2025-01-01' }
      ]
    }
  });
  const incoherent = outcomes.find((o) => o.code === 'OBLIGATION_DATES_INCOHERENT');
  assert.ok(incoherent, 'OBLIGATION_DATES_INCOHERENT produced');
  assert.equal(incoherent.severity, 'warn');
  assert.equal(incoherent.passed, false);
}));

track(test('contract: obligation end_date before contract effective → OBLIGATION_ENDS_BEFORE_CONTRACT', () => {
  const outcomes = validateContract({
    header: {},
    summary: {
      effective_start_date: '2025-06-01',
      obligations: [
        { start_date: '2025-01-01', end_date: '2025-03-01' }
      ]
    }
  });
  const before = outcomes.find((o) => o.code === 'OBLIGATION_ENDS_BEFORE_CONTRACT');
  assert.ok(before, 'OBLIGATION_ENDS_BEFORE_CONTRACT produced');
  assert.equal(before.severity, 'warn');
}));

track(test('contract: obligation negative amount → OBLIGATION_NEGATIVE_AMOUNT', () => {
  const outcomes = validateContract({
    header: {},
    summary: {
      obligations: [
        { amount: -500 }
      ]
    }
  });
  const neg = outcomes.find((o) => o.code === 'OBLIGATION_NEGATIVE_AMOUNT');
  assert.ok(neg, 'OBLIGATION_NEGATIVE_AMOUNT produced');
  assert.equal(neg.severity, 'warn');
}));

track(test('contract: obligation currency mismatch → OBLIGATION_CURRENCY_MISMATCH', () => {
  const outcomes = validateContract({
    header: {},
    summary: {
      currency: 'GBP',
      obligations: [
        { currency: 'USD', amount: 100 }
      ]
    }
  });
  const mismatch = outcomes.find((o) => o.code === 'OBLIGATION_CURRENCY_MISMATCH');
  assert.ok(mismatch, 'OBLIGATION_CURRENCY_MISMATCH produced');
  assert.equal(mismatch.severity, 'warn');
}));

track(test('contract: valid obligation produces no warnings', () => {
  const outcomes = validateContract({
    header: {},
    summary: {
      effective_start_date: '2025-01-01',
      effective_end_date: '2025-12-31',
      currency: 'GBP',
      obligations: [
        { start_date: '2025-01-01', end_date: '2025-12-31', amount: 5000, currency: 'GBP' }
      ]
    }
  });
  const warnings = outcomes.filter((o) => !o.passed);
  assert.equal(warnings.length, 0);
}));

track(test('contract: obligations absent → no obligation outcomes', () => {
  const outcomes = validateContract({
    header: {},
    summary: { effective_start_date: '2025-01-01' }
  });
  const obligationCodes = outcomes.filter((o) => o.code.startsWith('OBLIGATION_'));
  assert.equal(obligationCodes.length, 0);
}));

track(test('contract: uses effective_start_date from summary (not header.document_date)', () => {
  const outcomes = validateContract({
    header: { document_date: '2025-01-01' },
    summary: {
      effective_start_date: '2025-06-01',
      effective_end_date: '2025-03-01'
    }
  });
  const inverted = outcomes.find((o) => o.code === 'CONTRACT_DATES_INVERTED');
  assert.ok(inverted, 'uses effective_start_date from summary');
}));

track(test('outcomesToLegacyWarnings: obligation codes map to tokens', () => {
  const warnings = outcomesToLegacyWarnings([
    { code: 'OBLIGATION_DATES_INCOHERENT', severity: 'warn', passed: false },
    { code: 'OBLIGATION_NEGATIVE_AMOUNT', severity: 'warn', passed: false },
    { code: 'OBLIGATION_CURRENCY_MISMATCH', severity: 'warn', passed: false }
  ]);
  assert.ok(warnings.includes('obligation_dates_incoherent'));
  assert.ok(warnings.includes('obligation_negative_amount'));
  assert.ok(warnings.includes('obligation_currency_mismatch'));
}));

// ── RT-04: the invoice/bill and receipt validators delegate the totals
// equation to validateReceiptTotals (finding F-05) ───────────────────
//
// Same table as totalsValidation.test.js. A verdict that differs between
// the formula and either validator is the bug this slice removed.

for (const c of TOTALS_TOLERANCE_CASES) {
  track(test(`invoice/bill agrees with the shared table: ${c.name}`, () => {
    const outcomes = validateInvoiceBill({ header: headerForCase(c.summary), summary: c.summary, lines: c.lines });
    const mismatch = outcomes.find((o) => o.code === 'INVOICE_TOTAL_MISMATCH');
    const reconciled = outcomes.find((o) => o.code === 'INVOICE_TOTAL_RECONCILED');
    if (c.expect.matches) {
      assert.equal(mismatch, undefined, `no mismatch outcome (${mismatch?.message})`);
      assert.ok(reconciled, 'reconciled outcome recorded');
    } else {
      assert.ok(mismatch, 'mismatch outcome recorded');
      assert.equal(reconciled, undefined);
    }
    const carrier = mismatch || reconciled;
    assert.equal(carrier.totals.strategy, c.expect.strategy, 'the outcome carries the formula receipt');
    assert.equal(carrier.totals.drift, c.expect.drift);
  }));

  track(test(`receipt agrees with the shared table: ${c.name}`, () => {
    const outcomes = validateReceipt({ header: headerForCase(c.summary), summary: c.summary, lines: c.lines });
    const mismatch = outcomes.find((o) => o.code === 'RECEIPT_TOTAL_MISMATCH');
    const reconciled = outcomes.find((o) => o.code === 'RECEIPT_TOTAL_RECONCILED');
    if (c.header_only) {
      // A receipt with no lines has nothing to reconcile — the gating this
      // validator always had; RT-04 adds no review-row source.
      assert.equal(mismatch, undefined);
      assert.equal(reconciled, undefined);
      return;
    }
    if (c.expect.matches) {
      assert.equal(mismatch, undefined, `no mismatch outcome (${mismatch?.message})`);
      assert.ok(reconciled, 'reconciled outcome recorded');
    } else {
      assert.ok(mismatch, 'mismatch outcome recorded');
      assert.equal(reconciled, undefined);
    }
    assert.equal((mismatch || reconciled).totals.strategy, c.expect.strategy);
  }));
}

for (const c of TOTALS_NO_OPINION_CASES) {
  track(test(`invoice/bill stays silent with the shared table: ${c.name}`, () => {
    const outcomes = validateInvoiceBill({ header: headerForCase(c.summary), summary: c.summary, lines: c.lines });
    assert.equal(outcomes.find((o) => o.code === 'INVOICE_TOTAL_MISMATCH'), undefined);
    assert.equal(outcomes.find((o) => o.code === 'INVOICE_TOTAL_RECONCILED'), undefined);
  }));
  track(test(`receipt stays silent with the shared table: ${c.name}`, () => {
    const outcomes = validateReceipt({ header: headerForCase(c.summary), summary: c.summary, lines: c.lines });
    assert.equal(outcomes.find((o) => o.code === 'RECEIPT_TOTAL_MISMATCH'), undefined);
    assert.equal(outcomes.find((o) => o.code === 'RECEIPT_TOTAL_RECONCILED'), undefined);
  }));
}

track(test('Social DXB through the dispatcher and the legacy bridge → zero amount_mismatch', () => {
  const [social] = TOTALS_TOLERANCE_CASES;
  const outcomes = validateDocument({
    documentType: 'supplier_bill',
    header: headerForCase(social.summary),
    summary: social.summary,
    lines: social.lines
  });
  assert.equal(outcomesToLegacyWarnings(outcomes).includes('amount_mismatch'), false);
  const receipt = totalsReceiptFromOutcomes(outcomes);
  assert.ok(receipt, 'the outcomes carry the totals receipt');
  assert.equal(receipt.strategy, 'declared_tax_exclusive');
  assert.equal(receipt.expected, 550);
  assert.equal(receipt.total, 550);
  assert.equal(receipt.drift, 0);
}));

track(test('header repaired after the mapper ran: the validator reads header.total_amount first', () => {
  // The mapper saw no total (no opinion). The repair pass later filled
  // header.total_amount; the worker-side validator must judge the repaired
  // number, not the stale summary copy.
  const outcomes = validateInvoiceBill({
    header: { total_amount: 130, tax_amount: 10 },
    summary: { subtotal_amount: 100, total_amount: null, tax_amount: 10 },
    lines: []
  });
  const mismatch = outcomes.find((o) => o.code === 'INVOICE_TOTAL_MISMATCH');
  assert.ok(mismatch);
  assert.equal(mismatch.totals.total, 130);
  assert.equal(mismatch.totals.drift, 20);
}));

track(test('INVOICE_LINE_SUM_MISMATCH is a different fact: it never maps to amount_mismatch', () => {
  const warnings = outcomesToLegacyWarnings([
    { code: 'INVOICE_LINE_SUM_MISMATCH', severity: 'warn', passed: false }
  ]);
  assert.equal(warnings.includes('amount_mismatch'), false);
}));

track(test('line sum ≠ subtotal while the totals foot: line-sum outcome kept, totals reconciled', () => {
  const outcomes = validateInvoiceBill({
    header: { total_amount: 110, tax_amount: 10 },
    summary: { subtotal_amount: 100 },
    lines: [{ amount: 50 }, { amount: 30 }]
  });
  assert.ok(outcomes.find((o) => o.code === 'INVOICE_LINE_SUM_MISMATCH'), 'line-sum check untouched');
  assert.ok(outcomes.find((o) => o.code === 'INVOICE_TOTAL_RECONCILED'), 'totals judged on the printed subtotal');
  assert.equal(outcomesToLegacyWarnings(outcomes).includes('amount_mismatch'), false);
}));

track(test('totalsReceiptFromOutcomes: null when no totals outcome exists', () => {
  assert.equal(totalsReceiptFromOutcomes([]), null);
  assert.equal(totalsReceiptFromOutcomes([{ code: 'INVOICE_REFERENCE_PRESENT', passed: true }]), null);
  assert.equal(totalsReceiptFromOutcomes(undefined), null);
}));

// ── Settlement rows (RT-21b) ─────────────────────────────────────────

track(test('settlement rows: a footing koontilasku → SETTLEMENT_ROWS_RECONCILED (info); a non-footing one → warn + the settlement_rows_mismatch legacy token', () => {
  const footing = validateSettlementStatement({
    summary: { settlement: { rows_validation: { matches: true, row_count: 4, rows_missing_net: 0, expected: 10206.48, total: 10206.48, drift: 0, tolerance: 0.04, reason: null } } }
  });
  assert.equal(footing.length, 1);
  assert.equal(footing[0].code, 'SETTLEMENT_ROWS_RECONCILED');
  assert.equal(footing[0].severity, 'info');
  assert.equal(footing[0].passed, true);
  assert.equal(footing[0].rows.row_count, 4);
  assert.equal(hasWarnOutcome(footing), false);
  assert.deepEqual(outcomesToLegacyWarnings(footing), []);

  const drift = validateSettlementStatement({
    summary: { settlement: { rows_validation: { matches: false, row_count: 4, rows_missing_net: 0, expected: 10206.48, total: 10196.48, drift: -10, tolerance: 0.04, reason: 'rows_do_not_foot' } } }
  });
  assert.equal(drift[0].code, 'SETTLEMENT_ROWS_MISMATCH');
  assert.equal(drift[0].severity, 'warn');
  assert.match(drift[0].message, /10196.48.*10206.48/);
  assert.equal(hasWarnOutcome(drift), true);
  assert.deepEqual(outcomesToLegacyWarnings(drift), ['settlement_rows_mismatch']);
  assert.equal(outcomesToLegacyWarnings(drift).includes('amount_mismatch'), false, 'rows not footing is a different fact from the totals not footing');

  const missing = validateSettlementStatement({
    summary: { settlement: { rows_validation: { matches: false, row_count: 4, rows_missing_net: 1, expected: 10206.48, total: 7753.76, drift: -2452.72, tolerance: 0.04, reason: 'row_net_missing' } } }
  });
  assert.match(missing[0].message, /1 of 4 settlement rows print no net/);
}));

track(test('settlement rows: no rows → no opinion; validateDocument routes payout_statement and deposit_slip here', () => {
  assert.deepEqual(validateSettlementStatement({ summary: { settlement: { rows: [], rows_validation: null } } }), []);
  assert.deepEqual(validateSettlementStatement({ summary: {} }), []);
  assert.deepEqual(validateDocument({ documentType: 'deposit_slip', summary: { settlement: { rows_validation: null } } }), []);
  const routed = validateDocument({
    documentType: 'payout_statement',
    summary: { settlement: { rows_validation: { matches: true, row_count: 2, rows_missing_net: 0, expected: 10, total: 10, drift: 0, tolerance: 0.02, reason: null } } }
  });
  assert.equal(routed[0].code, 'SETTLEMENT_ROWS_RECONCILED');
}));

console.log(`documentValidator: ${passed} passed, ${failed} failed.`);
