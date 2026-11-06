// Contract tests for Phase 8a+8c role-gated flat-column projection.
//
// Validates that mapExtractionToWriterShape only populates vendor_name,
// total_amount, document_date, etc. from explicitly allowed roles —
// never from heuristic fallbacks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  __mapExtractionToWriterShape as mapExtractionToWriterShape,
  __VENDOR_ALLOWED_ROLES,
  __TOTAL_AMOUNT_ROLE_PRIORITY,
  __DOCUMENT_DATE_ROLE_PRIORITY,
  __AMOUNT_ROLE_VALUES,
  __PARTY_ROLE_VALUES,
  __DATE_ROLE_VALUES
} from './genericDocument.js';

let totalPassed = 0;
let totalFailed = 0;

const baseParsed = {
  extraction_status: 'validated',
  extraction_confidence: 0.9,
  document_type_guess: 'test_document',
  parties: [],
  amounts: [],
  dates: [],
  references: [],
  summary_text: 'Test document.',
  warnings: []
};

// ── 1. Disallowed party roles produce null vendor_name ──────────────

const DISALLOWED_VENDOR_ROLES = [
  'government_agency', 'bank', 'certifier', 'insurer', 'landlord',
  'director', 'shareholder', 'tenant', 'employer', 'employee',
  'borrower', 'lender'
];

for (const role of DISALLOWED_VENDOR_ROLES) {
  test(`disallowed party role "${role}" produces null vendor_name`, () => {
    const { header } = mapExtractionToWriterShape({
      ...baseParsed,
      parties: [{ name: 'Some Entity', role }]
    });
    assert.equal(header.vendor_name, null,
      `role "${role}" should NOT produce a vendor_name`);
    totalPassed++;
  });
}

// ── 2. Allowed party roles produce vendor_name ──────────────────────

test('supplier role produces vendor_name', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    parties: [{ name: 'Acme Supplies Ltd', role: 'supplier' }]
  });
  assert.equal(header.vendor_name, 'Acme Supplies Ltd');
  totalPassed++;
});

test('merchant role produces vendor_name', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    parties: [{ name: 'Corner Shop', role: 'merchant' }]
  });
  assert.equal(header.vendor_name, 'Corner Shop');
  totalPassed++;
});

// ── 3. Disallowed amount roles produce null total_amount ────────────

const DISALLOWED_AMOUNT_ROLES = [
  'opening_balance', 'closing_balance', 'credit_limit', 'loan_principal',
  'claim_amount', 'annual_total', 'monthly_installment', 'fee', 'premium',
  'interest', 'deposit', 'penalty', 'discount', 'subtotal', 'tax', 'refund'
];

for (const role of DISALLOWED_AMOUNT_ROLES) {
  test(`disallowed amount role "${role}" produces null total_amount`, () => {
    const { header } = mapExtractionToWriterShape({
      ...baseParsed,
      amounts: [{ value: 999.99, currency: 'GBP', label: 'test', role }]
    });
    assert.equal(header.total_amount, null,
      `amount role "${role}" should NOT produce a total_amount`);
    totalPassed++;
  });
}

// ── 4. Allowed amount roles produce total_amount ────────────────────

test('amount_paid role produces total_amount', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    amounts: [{ value: 150.0, currency: 'GBP', label: 'payment', role: 'amount_paid' }]
  });
  assert.equal(header.total_amount, 150.0);
  totalPassed++;
});

test('amount_due role produces total_amount', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    amounts: [{ value: 200.0, currency: 'USD', label: 'owed', role: 'amount_due' }]
  });
  assert.equal(header.total_amount, 200.0);
  totalPassed++;
});

test('total_gross role produces total_amount', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    amounts: [{ value: 300.0, currency: 'EUR', label: 'gross', role: 'total_gross' }]
  });
  assert.equal(header.total_amount, 300.0);
  totalPassed++;
});

// ── 5. Amount role priority ─────────────────────────────────────────

test('amount_paid wins over amount_due when both present', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    amounts: [
      { value: 50.0, currency: 'GBP', label: 'due', role: 'amount_due' },
      { value: 30.0, currency: 'GBP', label: 'paid', role: 'amount_paid' }
    ]
  });
  assert.equal(header.total_amount, 30.0);
  totalPassed++;
});

test('amount_due wins over total_gross when both present', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    amounts: [
      { value: 500.0, currency: 'GBP', label: 'gross', role: 'total_gross' },
      { value: 400.0, currency: 'GBP', label: 'due', role: 'amount_due' }
    ]
  });
  assert.equal(header.total_amount, 400.0);
  totalPassed++;
});

// ── 6. Date role priority ───────────────────────────────────────────

test('document_date wins over issue_date when both present', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    dates: [
      { value: '2026-03-01', label: 'issued', role: 'issue_date' },
      { value: '2026-04-15', label: 'document', role: 'document_date' }
    ]
  });
  assert.equal(header.document_date, '2026-04-15');
  totalPassed++;
});

test('issue_date wins over payment_date when both present', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    dates: [
      { value: '2026-02-20', label: 'paid', role: 'payment_date' },
      { value: '2026-01-10', label: 'issued', role: 'issue_date' }
    ]
  });
  assert.equal(header.document_date, '2026-01-10');
  totalPassed++;
});

// ── 7. due_date populated from due_date role ────────────────────────

test('due_date populated from due_date role', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    dates: [
      { value: '2026-06-01', label: 'payment due', role: 'due_date' },
      { value: '2026-05-01', label: 'document', role: 'document_date' }
    ]
  });
  assert.equal(header.due_date, '2026-06-01');
  assert.equal(header.document_date, '2026-05-01');
  totalPassed++;
});

test('due_date is null when no due_date role present', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    dates: [
      { value: '2026-05-01', label: 'document', role: 'document_date' }
    ]
  });
  assert.equal(header.due_date, null);
  totalPassed++;
});

// ── 8. All data in parse_summary regardless of flat-column projection

test('parties in summary even when vendor_name is null', () => {
  const { header, summary } = mapExtractionToWriterShape({
    ...baseParsed,
    parties: [
      { name: 'HMRC', role: 'government_agency' },
      { name: 'John Doe', role: 'customer' }
    ]
  });
  assert.equal(header.vendor_name, null);
  assert.equal(summary.parties.length, 2);
  assert.equal(summary.parties[0].name, 'HMRC');
  assert.equal(summary.parties[0].role, 'government_agency');
  assert.equal(summary.parties[1].name, 'John Doe');
  assert.equal(summary.parties[1].role, 'customer');
  totalPassed++;
});

test('amounts in summary even when total_amount is null', () => {
  const { header, summary } = mapExtractionToWriterShape({
    ...baseParsed,
    amounts: [
      { value: 12000.0, currency: 'GBP', label: 'balance', role: 'opening_balance' },
      { value: 11500.0, currency: 'GBP', label: 'closing', role: 'closing_balance' }
    ]
  });
  assert.equal(header.total_amount, null);
  assert.equal(summary.amounts.length, 2);
  assert.equal(summary.amounts[0].value, 12000.0);
  assert.equal(summary.amounts[1].value, 11500.0);
  totalPassed++;
});

// ── 9. customer_name only from customer role, only when vendor_name is set

test('customer_name set when vendor_name is set and customer role present', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    parties: [
      { name: 'Acme Ltd', role: 'supplier' },
      { name: 'Bob Corp', role: 'customer' }
    ]
  });
  assert.equal(header.vendor_name, 'Acme Ltd');
  assert.equal(header.customer_name, 'Bob Corp');
  totalPassed++;
});

test('customer_name null when vendor_name is null even if customer role present', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    parties: [
      { name: 'Bob Corp', role: 'customer' }
    ]
  });
  assert.equal(header.vendor_name, null);
  assert.equal(header.customer_name, null);
  totalPassed++;
});

test('customer_name null when vendor_name set but no customer role', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    parties: [
      { name: 'Acme Ltd', role: 'supplier' },
      { name: 'Some Bank', role: 'bank' }
    ]
  });
  assert.equal(header.vendor_name, 'Acme Ltd');
  assert.equal(header.customer_name, null);
  totalPassed++;
});

// ── 10. Null is safe default ────────────────────────────────────────

test('empty parties produce null vendor_name', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    parties: []
  });
  assert.equal(header.vendor_name, null);
  assert.equal(header.customer_name, null);
  totalPassed++;
});

test('empty amounts produce null total_amount', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    amounts: []
  });
  assert.equal(header.total_amount, null);
  assert.equal(header.currency, null);
  totalPassed++;
});

test('empty dates produce null document_date and null due_date', () => {
  const { header } = mapExtractionToWriterShape({
    ...baseParsed,
    dates: []
  });
  assert.equal(header.document_date, null);
  assert.equal(header.due_date, null);
  totalPassed++;
});
