// Cross-matcher parity tests. Covers business invariants the receipt,
// supplier_bill, and sales_invoice matchers MUST agree on. Each of the
// invariants below was a recent production regression:
//
//   - PR #175: receipt's currenciesMatch returned `false` for one-sided
//     null while the AR/AP matchers returned `true`. Suggestions for
//     receipts vanished silently when extraction failed to read the
//     currency line.
//
//   - PR #176: receipt/sales_invoice's shared `daysBetween` produced
//     `Infinity` when fed JS Date objects coming back from
//     node-postgres. The bill matcher escaped via a local helper. All
//     tier gates failed silently.
//
// These tests exist so the next divergence trips a red CI build, not a
// production incident.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  currencyCompatibility,
  currenciesCompatibleForSuggestion,
  currenciesCompatibleForAutoMatch,
  CURRENCY_CERTAINTY,
  daysBetween
} from './matcherCompatibility.js';
import { evaluateAutoMatch } from './receiptReconciliation.js';
import { evaluateBillAutoMatch } from './billReconciliation.js';
import { evaluateSalesInvoiceAutoMatch } from './salesInvoiceReconciliation.js';

// ── 1. currencyCompatibility business semantics ─────────────────────

describe('currencyCompatibility — categorical certainty', () => {
  test('both populated and equal → suggestion + autoMatch, certainty=both', () => {
    const r = currencyCompatibility('EUR', 'EUR');
    assert.equal(r.suggestion, true);
    assert.equal(r.autoMatch, true);
    assert.equal(r.certainty, CURRENCY_CERTAINTY.BOTH);
  });

  test('case-insensitive (eur vs EUR) → equal', () => {
    const r = currencyCompatibility('eur', 'EUR');
    assert.equal(r.suggestion, true);
    assert.equal(r.autoMatch, true);
    assert.equal(r.certainty, CURRENCY_CERTAINTY.BOTH);
  });

  test('both populated and different → neither, certainty=mismatch', () => {
    const r = currencyCompatibility('EUR', 'USD');
    assert.equal(r.suggestion, false);
    assert.equal(r.autoMatch, false);
    assert.equal(r.certainty, CURRENCY_CERTAINTY.MISMATCH);
  });

  test('one-sided null (tx populated, doc null) → suggestion only', () => {
    const r = currencyCompatibility('GBP', null);
    assert.equal(r.suggestion, true, 'reviewer can still adjudicate suggestions');
    assert.equal(r.autoMatch, false, 'auto-match requires both sides declared');
    assert.equal(r.certainty, CURRENCY_CERTAINTY.ONE_SIDED_NULL);
  });

  test('one-sided null (tx null, doc populated) → suggestion only', () => {
    const r = currencyCompatibility(null, 'GBP');
    assert.equal(r.suggestion, true);
    assert.equal(r.autoMatch, false);
    assert.equal(r.certainty, CURRENCY_CERTAINTY.ONE_SIDED_NULL);
  });

  test('one-sided empty string treated as null', () => {
    const r = currencyCompatibility('', 'GBP');
    assert.equal(r.suggestion, true);
    assert.equal(r.autoMatch, false);
    assert.equal(r.certainty, CURRENCY_CERTAINTY.ONE_SIDED_NULL);
  });

  test('both null → suggestion only (no evidence on either side)', () => {
    const r = currencyCompatibility(null, null);
    assert.equal(r.suggestion, true);
    assert.equal(r.autoMatch, false, 'no evidence is not the same as agreement');
    assert.equal(r.certainty, CURRENCY_CERTAINTY.BOTH_NULL);
  });

  test('boolean shorthands match the object form', () => {
    assert.equal(currenciesCompatibleForSuggestion('EUR', 'EUR'), true);
    assert.equal(currenciesCompatibleForAutoMatch('EUR', 'EUR'), true);
    assert.equal(currenciesCompatibleForSuggestion('EUR', 'USD'), false);
    assert.equal(currenciesCompatibleForAutoMatch('EUR', null), false);
    assert.equal(currenciesCompatibleForSuggestion('EUR', null), true);
  });
});

// ── 2. All three matchers reject one-sided null for auto-match ───────
//
// Each matcher's auto-match gate must include `currency_mismatch` in
// blockers when currencies aren't strictly compatible (both populated
// AND equal). Suggestions remain unaffected; this only governs the
// "skip review" lane.

const STD_RECEIPT_TX = {
  money_out: 100, currency: 'EUR', date: '2026-05-01',
  description: 'CABIFY ESP'
};
const STD_RECEIPT_DOC = {
  total_amount: 100, currency: 'EUR', document_date: '2026-05-01',
  vendor_name: 'Cabify', extraction_confidence: 0.95,
  parse_summary: { warnings: [] }, duplicate_of: null
};

const STD_BILL_TX = {
  money_out: 200, currency: 'GBP',
  description: 'WEWORK LONDON',
  date: '2026-05-10'
};
const STD_BILL_DOC = {
  total_amount: 200, currency: 'GBP',
  vendor_name: 'WeWork', extraction_confidence: 0.95,
  document_date: '2026-05-10',
  parse_summary: { warnings: [] }, duplicate_of: null
};

const STD_INVOICE_TX = {
  money_in: 1450, currency: 'GBP',
  description: 'TENANT R OKONKWO RENT',
  date: '2026-05-01'
};
const STD_INVOICE_DOC = {
  total_amount: 1450, currency: 'GBP',
  customer_name: 'R Okonkwo', extraction_confidence: 0.95,
  document_date: '2026-05-01',
  parse_summary: { warnings: [] }, duplicate_of: null
};

const scoredTier1Receipt = { confidence: 0.95, tier: 'amount_exact_reference', hints: [] };
const scoredTier1Bill = {
  confidence: 0.95, tier: 'amount_exact_reference', summary: '',
  hints: ['amount_exact', 'reference_match', 'vendor_overlap', 'within_window']
};
const scoredTier1Invoice = {
  confidence: 0.95, tier: 'amount_exact_reference', summary: '',
  hints: ['amount_exact', 'reference_match', 'customer_overlap', 'within_window']
};

describe('All three matchers — currency_mismatch fires consistently for auto-match', () => {
  test('receipt: happy-path currencies match → no currency blocker', () => {
    const r = evaluateAutoMatch({
      score: 0.95,
      transaction: STD_RECEIPT_TX,
      document: STD_RECEIPT_DOC
    });
    assert.equal(r.blockers.includes('currency_mismatch'), false);
  });

  test('receipt: genuine mismatch (EUR/USD) → currency_mismatch', () => {
    const r = evaluateAutoMatch({
      score: 0.95,
      transaction: { ...STD_RECEIPT_TX, currency: 'USD' },
      document: STD_RECEIPT_DOC
    });
    assert.ok(r.blockers.includes('currency_mismatch'));
  });

  test('receipt: doc currency null + tx populated → currency_mismatch (auto-match)', () => {
    const r = evaluateAutoMatch({
      score: 0.95,
      transaction: STD_RECEIPT_TX,
      document: { ...STD_RECEIPT_DOC, currency: null }
    });
    assert.ok(
      r.blockers.includes('currency_mismatch'),
      'one-sided null currency must block auto-match (suggestion path is still allowed via the suggestion-level check)'
    );
  });

  test('receipt: tx currency null + doc populated → currency_mismatch (auto-match)', () => {
    const r = evaluateAutoMatch({
      score: 0.95,
      transaction: { ...STD_RECEIPT_TX, currency: null },
      document: STD_RECEIPT_DOC
    });
    assert.ok(r.blockers.includes('currency_mismatch'));
  });

  test('receipt: both null → currency_mismatch (no evidence ≠ agreement)', () => {
    const r = evaluateAutoMatch({
      score: 0.95,
      transaction: { ...STD_RECEIPT_TX, currency: null },
      document: { ...STD_RECEIPT_DOC, currency: null }
    });
    assert.ok(r.blockers.includes('currency_mismatch'));
  });

  test('bill: happy-path currencies match → no currency blocker', () => {
    const r = evaluateBillAutoMatch({
      scored: scoredTier1Bill,
      transaction: STD_BILL_TX,
      document: STD_BILL_DOC
    });
    assert.equal(r.blockers.includes('currency_mismatch'), false);
  });

  test('bill: genuine mismatch (GBP/USD) → currency_mismatch', () => {
    const r = evaluateBillAutoMatch({
      scored: scoredTier1Bill,
      transaction: { ...STD_BILL_TX, currency: 'USD' },
      document: STD_BILL_DOC
    });
    assert.ok(r.blockers.includes('currency_mismatch'));
  });

  test('bill: one-sided null → currency_mismatch (auto-match)', () => {
    const r = evaluateBillAutoMatch({
      scored: scoredTier1Bill,
      transaction: STD_BILL_TX,
      document: { ...STD_BILL_DOC, currency: null }
    });
    assert.ok(r.blockers.includes('currency_mismatch'));
  });

  test('bill: both null → currency_mismatch', () => {
    const r = evaluateBillAutoMatch({
      scored: scoredTier1Bill,
      transaction: { ...STD_BILL_TX, currency: null },
      document: { ...STD_BILL_DOC, currency: null }
    });
    assert.ok(r.blockers.includes('currency_mismatch'));
  });

  test('sales_invoice: happy-path currencies match → no currency blocker', () => {
    const r = evaluateSalesInvoiceAutoMatch({
      scored: scoredTier1Invoice,
      transaction: STD_INVOICE_TX,
      document: STD_INVOICE_DOC
    });
    assert.equal(r.blockers.includes('currency_mismatch'), false);
  });

  test('sales_invoice: genuine mismatch (GBP/EUR) → currency_mismatch', () => {
    const r = evaluateSalesInvoiceAutoMatch({
      scored: scoredTier1Invoice,
      transaction: { ...STD_INVOICE_TX, currency: 'EUR' },
      document: STD_INVOICE_DOC
    });
    assert.ok(r.blockers.includes('currency_mismatch'));
  });

  test('sales_invoice: one-sided null → currency_mismatch (auto-match)', () => {
    const r = evaluateSalesInvoiceAutoMatch({
      scored: scoredTier1Invoice,
      transaction: STD_INVOICE_TX,
      document: { ...STD_INVOICE_DOC, currency: null }
    });
    assert.ok(r.blockers.includes('currency_mismatch'));
  });

  test('sales_invoice: both null → currency_mismatch', () => {
    const r = evaluateSalesInvoiceAutoMatch({
      scored: scoredTier1Invoice,
      transaction: { ...STD_INVOICE_TX, currency: null },
      document: { ...STD_INVOICE_DOC, currency: null }
    });
    assert.ok(r.blockers.includes('currency_mismatch'));
  });
});

// ── 3. daysBetween survives pg Date objects on both inputs ───────────
//
// node-postgres returns JS Date for `date` columns. The shared helper
// must give the same answer regardless of which side is a Date and
// which is an ISO string.

describe('daysBetween — Date-object safety across all matchers', () => {
  test('two ISO strings, same day → 0', () => {
    assert.equal(daysBetween('2026-05-01', '2026-05-01'), 0);
  });

  test('two Date objects, same day → 0', () => {
    const d = new Date('2026-05-01T00:00:00Z');
    assert.equal(daysBetween(d, d), 0);
  });

  test('Date object vs ISO string → matches the all-string answer', () => {
    const isoVsIso = daysBetween('2026-05-01', '2026-05-05');
    const dateVsIso = daysBetween(new Date('2026-05-01T00:00:00Z'), '2026-05-05');
    const isoVsDate = daysBetween('2026-05-01', new Date('2026-05-05T00:00:00Z'));
    const dateVsDate = daysBetween(
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-05-05T00:00:00Z')
    );
    assert.equal(isoVsIso, 4);
    assert.equal(dateVsIso, 4, 'Date on left must give the same answer as ISO on left');
    assert.equal(isoVsDate, 4, 'Date on right must give the same answer as ISO on right');
    assert.equal(dateVsDate, 4, 'two Dates must give the same answer as two ISO strings');
  });

  test('non-zero gap, both Dates → finite integer (not Infinity)', () => {
    const a = new Date('2026-05-01T00:00:00Z');
    const b = new Date('2026-05-10T00:00:00Z');
    const gap = daysBetween(a, b);
    assert.ok(Number.isFinite(gap), 'must not return Infinity for valid Date inputs');
    assert.equal(gap, 9);
  });
});
