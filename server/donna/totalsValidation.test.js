// Unit tests for receipt totals validation (PR 2 of
// docs/invoice-receipt-parsing-plan.md). The behavioural pins:
//
//   - tax-inclusive vs tax-exclusive line amounts compute different
//     "expected" totals (the worker passes the LLM's flag through).
//   - shipping / discount / rounding shift expected as plan §"Totals
//     validation" describes.
//   - drift ≤ $1 → matches=true (tolerance respected, soft).
//   - drift > $1 → matches=false (worker forces every line into
//     review via the warnings channel).

import assert from 'node:assert/strict';

import { validateReceiptTotals, __TOTALS_TOLERANCE } from './totalsValidation.js';
import {
  TOTALS_TOLERANCE_CASES,
  TOTALS_NO_OPINION_CASES,
  TOTALS_RECEIPT_KEYS
} from './totalsValidation.cases.js';

let passed = 0;
let failed = 0;

const test = (name, fn) =>
  Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`  fail ${name}`);
      console.error(`       ${err?.stack || err?.message || err}`);
    });

const runTests = async () => {
  console.log('totalsValidation:');

  await test('tolerance is $1 (pinned default)', () => {
    assert.equal(__TOTALS_TOLERANCE, 1);
  });

  // ── tax-exclusive lines (typical invoice) ───────────────────────────

  await test('exclusive: subtotal + tax → matches', () => {
    const result = validateReceiptTotals({
      summary: {
        subtotal_amount: 100,
        tax_amount: 9,
        total_amount: 109,
        line_amounts_include_tax: false
      },
      lines: [{ amount: 60 }, { amount: 40 }]
    });
    assert.equal(result.matches, true);
    assert.equal(result.expected, 109);
  });

  await test('exclusive: subtotal + tax + shipping - discount + rounding → matches', () => {
    const result = validateReceiptTotals({
      summary: {
        subtotal_amount: 100,
        tax_amount: 9,
        shipping_amount: 5,
        discount_amount: 4,
        rounding_amount: 0.01,
        total_amount: 110.01,
        line_amounts_include_tax: false
      },
      lines: [{ amount: 100 }]
    });
    assert.equal(result.matches, true);
  });

  // ── tax-inclusive lines (typical Singapore receipt) ─────────────────

  await test('inclusive: sum(lines) + shipping - discount + rounding → matches', () => {
    const result = validateReceiptTotals({
      summary: {
        // Tax already in the lines, so do NOT add tax_amount again.
        tax_amount: 1.13,
        total_amount: 13.63,
        line_amounts_include_tax: true
      },
      lines: [{ amount: 6.82 }, { amount: 6.81 }]
    });
    assert.equal(result.matches, true);
    assert.ok(Math.abs(result.expected - 13.63) < 0.001, `expected ≈ 13.63 (got ${result.expected})`);
  });

  await test('inclusive ignores tax_amount in expected (avoids double-count)', () => {
    // Sum of lines = 13.63. Tax field present but tax-inclusive means
    // it's just informational — expected should still be 13.63, NOT
    // 13.63 + 1.13.
    const result = validateReceiptTotals({
      summary: {
        tax_amount: 1.13,
        total_amount: 13.63,
        line_amounts_include_tax: true
      },
      lines: [{ amount: 6.82 }, { amount: 6.81 }]
    });
    assert.equal(result.matches, true);
    assert.equal(Math.round(result.drift * 100) / 100, 0);
  });

  await test('printed line sum can prove tax-inclusive amounts when the model flag is wrong', () => {
    // Cactus Blossom regression shape: Austin Water / Comcast line amounts
    // already totalled the invoice, while the model emitted
    // line_amounts_include_tax=false. Adding the header tax a second time
    // created a false amount_mismatch on every line.
    const result = validateReceiptTotals({
      summary: {
        tax_amount: 2,
        total_amount: 77.78,
        line_amounts_include_tax: false
      },
      lines: [{ amount: 45.18 }, { amount: 32.6 }]
    });
    assert.equal(result.matches, true);
    assert.ok(Math.abs(result.expected - 77.78) < 0.001);
    assert.equal(result.strategy, 'inferred_tax_inclusive');
    assert.equal(result.inferred_line_amounts_include_tax, true);
  });

  await test('printed total still catches a real mismatch under both tax interpretations', () => {
    const result = validateReceiptTotals({
      summary: {
        tax_amount: 2,
        total_amount: 82,
        line_amounts_include_tax: false
      },
      lines: [{ amount: 45.18 }, { amount: 32.6 }]
    });
    assert.equal(result.matches, false);
  });

  // ── Tolerance band ─────────────────────────────────────────────────

  await test('drift < $1 → matches=true (within tolerance)', () => {
    const result = validateReceiptTotals({
      summary: {
        subtotal_amount: 100,
        tax_amount: 9,
        total_amount: 109.5, // 0.5 over
        line_amounts_include_tax: false
      },
      lines: [{ amount: 100 }]
    });
    assert.equal(result.matches, true);
  });

  await test('drift exactly $1 → matches=true (boundary inclusive)', () => {
    const result = validateReceiptTotals({
      summary: {
        subtotal_amount: 100,
        tax_amount: 9,
        total_amount: 110, // exactly 1 over
        line_amounts_include_tax: false
      },
      lines: [{ amount: 100 }]
    });
    assert.equal(result.matches, true);
  });

  await test('drift > $1 → matches=false (amount_mismatch)', () => {
    const result = validateReceiptTotals({
      summary: {
        subtotal_amount: 100,
        tax_amount: 9,
        total_amount: 112, // 3 over
        line_amounts_include_tax: false
      },
      lines: [{ amount: 100 }]
    });
    assert.equal(result.matches, false);
    assert.equal(result.drift, 3);
  });

  await test('drift > $1 below total → matches=false too (signed drift)', () => {
    const result = validateReceiptTotals({
      summary: {
        subtotal_amount: 100,
        tax_amount: 9,
        total_amount: 105,
        line_amounts_include_tax: false
      },
      lines: [{ amount: 100 }]
    });
    assert.equal(result.matches, false);
    assert.equal(result.drift, -4);
  });

  // ── Sparse-input handling ──────────────────────────────────────────

  await test('missing total → matches=true (no opinion, no warning)', () => {
    const result = validateReceiptTotals({
      summary: { subtotal_amount: 100, line_amounts_include_tax: false },
      lines: [{ amount: 100 }]
    });
    assert.equal(result.matches, true);
    assert.equal(result.reason, 'no_total');
  });

  await test('no lines but total present → matches=true (accept header)', () => {
    const result = validateReceiptTotals({
      summary: { total_amount: 13.63 },
      lines: []
    });
    assert.equal(result.matches, true);
    assert.equal(result.reason, 'no_lines');
  });

  await test('inclusive without subtotal: sum(lines) is the source of truth', () => {
    const result = validateReceiptTotals({
      summary: {
        total_amount: 20,
        line_amounts_include_tax: true
      },
      lines: [{ amount: 10 }, { amount: 10 }]
    });
    assert.equal(result.matches, true);
  });

  await test('exclusive without subtotal falls back to summed lines + tax', () => {
    const result = validateReceiptTotals({
      summary: {
        tax_amount: 9,
        total_amount: 109,
        line_amounts_include_tax: false
        // No subtotal_amount.
      },
      lines: [{ amount: 60 }, { amount: 40 }]
    });
    assert.equal(result.matches, true);
    assert.equal(result.expected, 109);
  });


  // ── RT-04: one formula, one receipt (finding F-05) ─────────────────
  //
  // The shared table is the ratchet against a second formula growing
  // back: documentValidator.test.js runs the SAME cases through
  // validateInvoiceBill / validateReceipt and must agree on every verdict.

  for (const c of TOTALS_TOLERANCE_CASES) {
    await test(`shared table: ${c.name}`, () => {
      const result = validateReceiptTotals({ summary: c.summary, lines: c.lines });
      assert.equal(result.matches, c.expect.matches, `matches (drift ${result.drift}, strategy ${result.strategy})`);
      assert.equal(result.reason, null, 'an evaluated case carries no no-opinion reason');
      assert.equal(result.strategy, c.expect.strategy);
      assert.equal(result.drift, c.expect.drift, 'drift is persisted rounded, not as float noise');
      if (c.expect.basis) assert.equal(result.basis, c.expect.basis);
    });
  }

  for (const c of TOTALS_NO_OPINION_CASES) {
    await test(`shared table (no opinion): ${c.name}`, () => {
      const result = validateReceiptTotals({ summary: c.summary, lines: c.lines });
      assert.equal(result.matches, true);
      assert.equal(result.reason, c.expect.reason);
    });
  }

  await test('receipt shape: every persisted key is present on an evaluated verdict', () => {
    const [social] = TOTALS_TOLERANCE_CASES;
    const result = validateReceiptTotals({ summary: social.summary, lines: social.lines });
    for (const key of TOTALS_RECEIPT_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(result, key), `receipt carries ${key}`);
    }
    assert.equal(result.expected, 550);
    assert.equal(result.total, 550);
    assert.equal(result.line_sum, 550);
    assert.equal(result.subtotal, 550);
    assert.equal(result.tax, 27.5);
    assert.equal(result.discount, 27.5);
    assert.equal(result.shipping, 0);
    assert.equal(result.rounding, 0);
    assert.equal(result.tolerance, __TOTALS_TOLERANCE);
    assert.equal(result.basis, 'lines');
  });

  await test('receipt shape: a no-opinion verdict still names its reason and the numbers it had', () => {
    const result = validateReceiptTotals({ summary: { subtotal_amount: 100 }, lines: [{ amount: 100 }] });
    for (const key of TOTALS_RECEIPT_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(result, key), `receipt carries ${key}`);
    }
    assert.equal(result.reason, 'no_total');
    assert.equal(result.subtotal, 100);
    assert.equal(result.line_sum, 100);
  });

  await test('float noise never reaches the receipt (0.1 + 0.2 lines against 0.3)', () => {
    const result = validateReceiptTotals({
      summary: { total_amount: 0.3, line_amounts_include_tax: true },
      lines: [{ amount: 0.1 }, { amount: 0.2 }]
    });
    assert.equal(result.matches, true);
    assert.equal(result.expected, 0.3);
    assert.equal(result.drift, 0);
    assert.equal(result.line_sum, 0.3);
  });

  console.log(`\ntotalsValidation: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
};

runTests();

// Printed subtotal excludes a separate fee; the complete pre-tax source lines
// still foot. A genuinely inconsistent source must remain inconsistent.
assert.equal(validateReceiptTotals({summary:{subtotal_amount:30,tax_amount:5,total_amount:39.06},
  lines:[{amount:30},{amount:4.06}]}).matches,true);
assert.equal(validateReceiptTotals({summary:{subtotal_amount:95.78,shipping_amount:14.95,tax_amount:14.44,total_amount:150.23},
  lines:[{amount:95.78}]}).matches,false);
