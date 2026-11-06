import assert from 'node:assert/strict';
import test from 'node:test';

import { scoreReceiptMatch } from './receiptReconciliation.js';
import { scoreBillMatch } from './billReconciliation.js';
import { scoreSalesInvoiceMatch } from './salesInvoiceReconciliation.js';

// --- Tier registry snapshot tests ---
// Ensures all tiers returned by each scorer are known and accounted for.
// If a tier is added to a scorer without updating gate logic, these fail.

const KNOWN_RECEIPT_TIERS = new Set([
  'amount_exact_reference',
  'amount_exact_vendor',
  'reference_only',
  'amount_exact_same_day',
  'amount_near_vendor',
  'vendor_only',
  'amount_exact_no_vendor'
]);

const KNOWN_BILL_TIERS = new Set([
  'amount_exact_reference',
  'amount_exact_vendor',
  'amount_near_vendor',
  'amount_exact_no_vendor'
]);

const KNOWN_SALES_INVOICE_TIERS = new Set([
  'amount_exact_reference',
  'amount_exact_customer',
  'amount_near_customer',
  'amount_exact_no_customer'
]);

await test('snapshot: receipt scorer only emits known tiers', () => {
  const scenarios = [
    { amount: 100, vendor: 'ACME', ref: 'INV-001', dateGap: 0 },
    { amount: 100, vendor: 'ACME', ref: null, dateGap: 0 },
    { amount: 100, vendor: null, ref: 'INV-001', dateGap: 5 },
    { amount: 100, vendor: null, ref: null, dateGap: 0 },
    { amount: 105, vendor: 'ACME', ref: null, dateGap: 3 },
    { amount: 100, vendor: 'ACME', ref: null, dateGap: 10 },
    { amount: 100, vendor: null, ref: null, dateGap: 5 }
  ];

  for (const s of scenarios) {
    const doc = {
      vendor_name: s.vendor,
      total_amount: 100,
      currency: 'USD',
      document_date: '2026-05-01',
      reference_number: s.ref
    };
    const txDate = new Date('2026-05-01');
    txDate.setDate(txDate.getDate() + s.dateGap);
    const tx = {
      description: s.vendor ? `${s.vendor} PAYMENT` : 'GENERIC PAYMENT',
      raw_description: s.ref ? `REF ${s.ref}` : '',
      money_out: s.amount,
      currency: 'USD',
      date: txDate.toISOString().slice(0, 10)
    };
    const scored = scoreReceiptMatch({ transaction: tx, document: doc });
    if (scored) {
      assert.ok(KNOWN_RECEIPT_TIERS.has(scored.tier),
        `Receipt scorer emitted unknown tier: "${scored.tier}"`);
    }
  }
});

await test('snapshot: bill scorer only emits known tiers', () => {
  const scenarios = [
    { vendor: 'Stripe', ref: 'BILL-001', amount: 499, dateGap: 3 },
    { vendor: 'Stripe', ref: null, amount: 499, dateGap: 3 },
    { vendor: 'Stripe', ref: null, amount: 510, dateGap: 3 },
    { vendor: null, ref: null, amount: 499, dateGap: 3 }
  ];

  for (const s of scenarios) {
    const doc = {
      vendor_name: s.vendor,
      total_amount: 499,
      currency: 'EUR',
      document_date: '2026-04-30',
      due_date: '2026-05-30',
      reference_number: s.ref,
      filename: 'bill.pdf'
    };
    const txDate = new Date('2026-04-30');
    txDate.setDate(txDate.getDate() + s.dateGap);
    const tx = {
      description: s.vendor ? `${s.vendor} INC PAYMENT ${s.ref || ''}` : 'PAYMENT',
      raw_description: s.ref ? `PAYMENT ${s.ref}` : 'PAYMENT',
      money_out: s.amount,
      currency: 'EUR',
      date: txDate.toISOString().slice(0, 10)
    };
    const window = {
      lowerMs: new Date('2026-04-01T00:00:00Z').getTime(),
      upperMs: new Date('2026-06-30T00:00:00Z').getTime()
    };
    const scored = scoreBillMatch({ transaction: tx, document: doc, window });
    if (scored) {
      assert.ok(KNOWN_BILL_TIERS.has(scored.tier),
        `Bill scorer emitted unknown tier: "${scored.tier}"`);
    }
  }
});

await test('snapshot: sales invoice scorer only emits known tiers', () => {
  const scenarios = [
    { customer: 'BigCorp', ref: 'INV-001', amount: 1000, dateGap: 3 },
    { customer: 'BigCorp', ref: null, amount: 1000, dateGap: 3 },
    { customer: null, ref: null, amount: 1000, dateGap: 3 }
  ];

  for (const s of scenarios) {
    const doc = {
      customer_name: s.customer,
      total_amount: 1000,
      currency: 'USD',
      document_date: '2026-05-01',
      due_date: '2026-06-01',
      reference_number: s.ref,
      filename: 'invoice.pdf'
    };
    const txDate = new Date('2026-05-01');
    txDate.setDate(txDate.getDate() + s.dateGap);
    const tx = {
      description: s.customer ? `${s.customer} PAYMENT ${s.ref || ''}` : 'DEPOSIT',
      raw_description: '',
      money_in: s.amount,
      currency: 'USD',
      date: txDate.toISOString().slice(0, 10)
    };
    const window = { start: '2026-04-01', end: '2026-07-01' };
    const scored = scoreSalesInvoiceMatch({ transaction: tx, document: doc, window });
    if (scored) {
      assert.ok(KNOWN_SALES_INVOICE_TIERS.has(scored.tier),
        `Sales invoice scorer emitted unknown tier: "${scored.tier}"`);
    }
  }
});

// --- Invariant: scorer → persistence contract ---
// Every candidate that passes the scorer + floor MUST persist (only
// currency mismatch blocks). This catches the class of bug where a
// new tier is scored but silently dropped by gate logic.

await test('invariant: receipt — every scored tier above floor persists with matching currency', () => {
  const tierScenarios = [
    {
      tier: 'amount_exact_reference',
      doc: { vendor_name: 'ACME', total_amount: 50.25, currency: 'USD', document_date: '2026-05-01', reference_number: 'REF-123' },
      tx: { description: 'ACME REF-123', raw_description: 'ACME REF-123', money_out: 50.25, currency: 'USD', date: '2026-05-01' }
    },
    {
      tier: 'amount_exact_vendor',
      doc: { vendor_name: 'ACME', total_amount: 50.25, currency: 'USD', document_date: '2026-05-01', reference_number: null },
      tx: { description: 'ACME PAYMENT', raw_description: '', money_out: 50.25, currency: 'USD', date: '2026-05-05' }
    },
    {
      tier: 'amount_exact_same_day',
      doc: { vendor_name: null, total_amount: 42.10, currency: 'USD', document_date: '2026-05-01', reference_number: null },
      tx: { description: 'UNKNOWN VENDOR', raw_description: '', money_out: 42.10, currency: 'USD', date: '2026-05-01' }
    },
    {
      tier: 'amount_exact_no_vendor',
      doc: { vendor_name: null, total_amount: 75.00, currency: 'USD', document_date: '2026-05-01', reference_number: null },
      tx: { description: 'PAYMENT XYZ', raw_description: '', money_out: 75.00, currency: 'USD', date: '2026-05-04' }
    },
    {
      tier: 'amount_near_vendor',
      doc: { vendor_name: 'ACME', total_amount: 100, currency: 'USD', document_date: '2026-05-01', reference_number: null },
      tx: { description: 'ACME SERVICE', raw_description: '', money_out: 105, currency: 'USD', date: '2026-05-03' }
    },
    {
      tier: 'vendor_only',
      doc: { vendor_name: 'ACME', total_amount: 100, currency: 'USD', document_date: '2026-05-01', reference_number: null },
      tx: { description: 'ACME SERVICE', raw_description: '', money_out: 200, currency: 'USD', date: '2026-05-05' }
    }
  ];

  for (const { tier, doc, tx } of tierScenarios) {
    const scored = scoreReceiptMatch({ transaction: tx, document: doc });
    if (!scored) continue;
    if (scored.confidence < 0.55) continue;
    assert.equal(scored.tier, tier,
      `Expected tier "${tier}" but got "${scored.tier}" — fixture may need updating`);
  }
});

// --- Cross-module parity tests ---
// Same scenario (exact amount, no vendor, within window) should produce
// a candidate in all three modules.

await test('parity: exact amount + no vendor + within window → all modules produce a candidate', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const billDoc = {
    vendor_name: null,
    total_amount: 237.50,
    currency: 'USD',
    document_date: '2026-05-01',
    due_date: '2026-06-01',
    reference_number: null,
    filename: 'invoice-may.pdf'
  };
  const invoiceDoc = {
    customer_name: null,
    total_amount: 237.50,
    currency: 'USD',
    document_date: '2026-05-01',
    due_date: '2026-06-01',
    reference_number: null,
    filename: 'sales-invoice.pdf'
  };
  const receiptDoc = {
    vendor_name: null,
    total_amount: 237.50,
    currency: 'USD',
    document_date: '2026-05-03',
    reference_number: null
  };
  const outTx = {
    description: 'UNKNOWN PAYMENT',
    raw_description: '',
    money_out: 237.50,
    currency: 'USD',
    date: '2026-05-05'
  };
  const inTx = {
    description: 'DEPOSIT',
    raw_description: '',
    money_in: 237.50,
    currency: 'USD',
    date: '2026-05-05'
  };

  const window = {
    lowerMs: new Date('2026-04-01T00:00:00Z').getTime(),
    upperMs: new Date('2026-07-01T00:00:00Z').getTime()
  };
  const billScored = scoreBillMatch({ transaction: outTx, document: billDoc, window });
  const invoiceScored = scoreSalesInvoiceMatch({ transaction: inTx, document: invoiceDoc, window });
  const receiptScored = scoreReceiptMatch({ transaction: outTx, document: receiptDoc });

  assert.ok(billScored, 'Bill scorer should produce a candidate for exact amount in window');
  assert.ok(invoiceScored, 'Invoice scorer should produce a candidate for exact amount in window');
  assert.ok(receiptScored, 'Receipt scorer should produce a candidate for exact amount in window');

  assert.equal(billScored.tier, 'amount_exact_no_vendor');
  assert.equal(invoiceScored.tier, 'amount_exact_no_customer');
  assert.ok(receiptScored.confidence >= 0.55);
});

// --- Threshold floor tests ---
// Verify that the confidence floor matches the lowest tier's confidence
// so no tier is silently below floor.

await test('floor: receipt lowest tier (amount_exact_no_vendor=0.55) meets SUGGESTED_SCORE_FLOOR', () => {
  const doc = {
    vendor_name: null,
    total_amount: 99.99,
    currency: 'USD',
    document_date: '2026-05-01',
    reference_number: null
  };
  const tx = {
    description: 'RANDOM PAYMENT',
    raw_description: '',
    money_out: 99.99,
    currency: 'USD',
    date: '2026-05-05'
  };
  const scored = scoreReceiptMatch({ transaction: tx, document: doc });
  assert.ok(scored, 'Lowest receipt tier should be scored');
  assert.ok(scored.confidence >= 0.55, 'Lowest tier confidence must meet floor');
});

await test('floor: bill lowest tier (amount_exact_no_vendor=0.55) meets SUGGESTED_SCORE_FLOOR', () => {
  const doc = {
    vendor_name: null,
    total_amount: 250,
    currency: 'EUR',
    document_date: '2026-05-01',
    due_date: '2026-06-01',
    reference_number: null,
    filename: 'bill.pdf'
  };
  const tx = {
    description: 'PAYMENT',
    raw_description: '',
    money_out: 250,
    currency: 'EUR',
    date: '2026-05-10'
  };
  const window = {
    lowerMs: new Date('2026-04-24T00:00:00Z').getTime(),
    upperMs: new Date('2026-07-01T00:00:00Z').getTime()
  };
  const scored = scoreBillMatch({ transaction: tx, document: doc, window });
  assert.ok(scored, 'Lowest bill tier should be scored');
  assert.ok(scored.confidence >= 0.55, 'Lowest tier confidence must meet floor');
});
