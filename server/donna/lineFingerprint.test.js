// Unit tests for the document_lines content fingerprint (PR 2 of
// docs/invoice-receipt-parsing-plan.md). The algorithm propagates
// into PR 3's re-parse merge — these tests pin the invariants the
// merge relies on, so changing the normalisation rules requires
// explicit test updates.

import assert from 'node:assert/strict';

import {
  lineFingerprint,
  __normalizeDescription,
  __formatAmount,
  __formatQuantity
} from './lineFingerprint.js';

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
  console.log('lineFingerprint:');

  // ── Hash shape ──────────────────────────────────────────────────────

  await test('fingerprint is a 64-char hex sha256', () => {
    const fp = lineFingerprint({
      description: 'Latte', quantity: 1, unit_price: 5, amount: 5, currency: 'SGD'
    });
    assert.match(fp, /^[0-9a-f]{64}$/);
  });

  // ── Stability ───────────────────────────────────────────────────────

  await test('identical inputs → identical hash', () => {
    const args = { description: 'Latte', quantity: 1, unit_price: 5, amount: 5, currency: 'SGD' };
    assert.equal(lineFingerprint(args), lineFingerprint({ ...args }));
  });

  // ── Description normalisation ──────────────────────────────────────

  await test('whitespace differences in description → same hash', () => {
    const a = lineFingerprint({ description: 'Oat milk latte', quantity: 1, amount: 6 });
    const b = lineFingerprint({ description: '  oat   milk   latte  ', quantity: 1, amount: 6 });
    assert.equal(a, b);
  });

  await test('case differences in description → same hash', () => {
    const a = lineFingerprint({ description: 'Cappuccino', amount: 4 });
    const b = lineFingerprint({ description: 'CAPPUCCINO', amount: 4 });
    const c = lineFingerprint({ description: 'cappuccino', amount: 4 });
    assert.equal(a, b);
    assert.equal(b, c);
  });

  await test('punctuation differences in description → same hash', () => {
    const a = lineFingerprint({ description: 'Latte, oat milk', amount: 6 });
    const b = lineFingerprint({ description: 'Latte - oat milk', amount: 6 });
    const c = lineFingerprint({ description: 'Latte oat milk!', amount: 6 });
    assert.equal(a, b);
    assert.equal(b, c);
  });

  await test('unicode diacritics fold (NFKD + strip combining marks)', () => {
    // "café" composed (U+00E9) vs decomposed (e + U+0301) vs ascii.
    const composed = lineFingerprint({ description: 'Café', amount: 4 });
    const decomposed = lineFingerprint({ description: 'Café', amount: 4 });
    const plain = lineFingerprint({ description: 'Cafe', amount: 4 });
    assert.equal(composed, decomposed);
    assert.equal(decomposed, plain);
  });

  // ── Numeric canonicalisation ───────────────────────────────────────

  await test('integer vs 2dp amount → same hash (canonical 2dp)', () => {
    const a = lineFingerprint({ description: 'Coffee', amount: 5 });
    const b = lineFingerprint({ description: 'Coffee', amount: 5.0 });
    const c = lineFingerprint({ description: 'Coffee', amount: '5.00' });
    assert.equal(a, b);
    assert.equal(b, c);
  });

  await test('quantity 1 vs 1.0000 → same hash (canonical 4dp)', () => {
    const a = lineFingerprint({ description: 'Coffee', quantity: 1, amount: 5 });
    const b = lineFingerprint({ description: 'Coffee', quantity: 1.0, amount: 5 });
    const c = lineFingerprint({ description: 'Coffee', quantity: '1.0000', amount: 5 });
    assert.equal(a, b);
    assert.equal(b, c);
  });

  // ── Discrimination ─────────────────────────────────────────────────

  await test('different amount → different hash', () => {
    const a = lineFingerprint({ description: 'Latte', amount: 5 });
    const b = lineFingerprint({ description: 'Latte', amount: 6 });
    assert.notEqual(a, b);
  });

  await test('different quantity → different hash', () => {
    const a = lineFingerprint({ description: 'Latte', quantity: 1, amount: 5 });
    const b = lineFingerprint({ description: 'Latte', quantity: 2, amount: 5 });
    assert.notEqual(a, b);
  });

  await test('different unit_price → different hash', () => {
    const a = lineFingerprint({ description: 'Latte', unit_price: 5, amount: 5 });
    const b = lineFingerprint({ description: 'Latte', unit_price: 6, amount: 5 });
    assert.notEqual(a, b);
  });

  await test('different currency → different hash', () => {
    const a = lineFingerprint({ description: 'Latte', amount: 5, currency: 'SGD' });
    const b = lineFingerprint({ description: 'Latte', amount: 5, currency: 'USD' });
    assert.notEqual(a, b);
  });

  await test('currency casing is normalised', () => {
    const a = lineFingerprint({ description: 'Latte', amount: 5, currency: 'sgd' });
    const b = lineFingerprint({ description: 'Latte', amount: 5, currency: 'SGD' });
    assert.equal(a, b);
  });

  await test('null vs undefined currency → same hash (both empty)', () => {
    const a = lineFingerprint({ description: 'Latte', amount: 5, currency: null });
    const b = lineFingerprint({ description: 'Latte', amount: 5 });
    assert.equal(a, b);
  });

  await test('null description hashes deterministically (not a crash)', () => {
    // The merge logic in PR 3 must not throw on a malformed line —
    // the fingerprint just won't match anything else useful.
    const fp = lineFingerprint({ description: null, amount: 5 });
    assert.match(fp, /^[0-9a-f]{64}$/);
  });

  // ── Pure helpers (smoke) ───────────────────────────────────────────

  await test('__normalizeDescription strips diacritics + lowercases', () => {
    assert.equal(__normalizeDescription('Café  Latté'), 'cafe latte');
  });

  await test('__formatAmount fixes to 2dp / null on missing', () => {
    assert.equal(__formatAmount(5), '5.00');
    assert.equal(__formatAmount('12.345'), '12.35');
    assert.equal(__formatAmount(null), '');
    assert.equal(__formatAmount(undefined), '');
    assert.equal(__formatAmount(''), '');
    assert.equal(__formatAmount('not-a-number'), '');
  });

  await test('__formatQuantity fixes to 4dp', () => {
    assert.equal(__formatQuantity(1), '1.0000');
    assert.equal(__formatQuantity(2.5), '2.5000');
    assert.equal(__formatQuantity(null), '');
  });

  console.log(`\nlineFingerprint: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
};

runTests();
