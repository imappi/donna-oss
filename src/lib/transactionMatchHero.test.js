// transactionMatchHero — FE pure-helper tests.
//
// Pins the derivations the Stage B MatchHero relies on so a future
// refactor to `vendorDisplayFor` / status vocabulary / date coercion
// can't silently regress the hero's title/fields/suppression.

import assert from 'node:assert/strict';

import {
  bestMatchForTransaction,
  docTypeLabel,
  isMeaningfulMatch,
  matchHeroFields,
  matchHeroReasoning,
  matchHeroTitle,
  shouldSuppressProactiveAskClient
} from './transactionMatchHero.js';

let passed = 0;
let failed = 0;

const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err?.stack || err?.message || err}`);
  }
};

console.log('transactionMatchHero (FE helpers):');

// ── isMeaningfulMatch ────────────────────────────────────────────────

await test('isMeaningfulMatch: confirmed → true', () => {
  assert.equal(isMeaningfulMatch({ status: 'confirmed' }), true);
});

await test('isMeaningfulMatch: auto_matched → true', () => {
  assert.equal(isMeaningfulMatch({ status: 'auto_matched' }), true);
});

await test('isMeaningfulMatch: suggested → true', () => {
  assert.equal(isMeaningfulMatch({ status: 'suggested' }), true);
});

await test('isMeaningfulMatch: rejected → false (rejected matches are dead, not meaningful)', () => {
  assert.equal(isMeaningfulMatch({ status: 'rejected' }), false);
});

await test('isMeaningfulMatch: null match → false', () => {
  assert.equal(isMeaningfulMatch(null), false);
});

await test('isMeaningfulMatch: missing status → false', () => {
  assert.equal(isMeaningfulMatch({}), false);
});

// ── bestMatchForTransaction ─────────────────────────────────────────

await test('bestMatchForTransaction: confirmed outranks auto_matched outranks suggested', () => {
  const matches = [
    { bank_transaction_id: 'tx-1', status: 'suggested', id: 'm-s' },
    { bank_transaction_id: 'tx-1', status: 'confirmed', id: 'm-c' },
    { bank_transaction_id: 'tx-1', status: 'auto_matched', id: 'm-a' }
  ];
  assert.equal(bestMatchForTransaction(matches, 'tx-1').id, 'm-c');
});

await test('bestMatchForTransaction: rejected rows never win, even when first', () => {
  const matches = [
    { bank_transaction_id: 'tx-1', status: 'rejected', id: 'm-r' },
    { bank_transaction_id: 'tx-1', status: 'suggested', id: 'm-s' }
  ];
  assert.equal(bestMatchForTransaction(matches, 'tx-1').id, 'm-s');
});

await test('bestMatchForTransaction: only rejected rows → null (artifact renders unmatched)', () => {
  const matches = [{ bank_transaction_id: 'tx-1', status: 'rejected', id: 'm-r' }];
  assert.equal(bestMatchForTransaction(matches, 'tx-1'), null);
});

await test('bestMatchForTransaction: scoped to the requested transaction', () => {
  const matches = [
    { bank_transaction_id: 'tx-2', status: 'confirmed', id: 'm-other' },
    { bank_transaction_id: 'tx-1', status: 'suggested', id: 'm-mine' }
  ];
  assert.equal(bestMatchForTransaction(matches, 'tx-1').id, 'm-mine');
});

await test('bestMatchForTransaction: empty/missing inputs → null', () => {
  assert.equal(bestMatchForTransaction([], 'tx-1'), null);
  assert.equal(bestMatchForTransaction(null, 'tx-1'), null);
  assert.equal(bestMatchForTransaction([{ bank_transaction_id: 'tx-1', status: 'suggested' }], null), null);
});

// ── matchHeroTitle ──────────────────────────────────────────────────

await test('matchHeroTitle: auto_matched → "Matched to <file> · auto-confirmed"', () => {
  const title = matchHeroTitle(
    { status: 'auto_matched' },
    { filename: '25-06-16_IRS_Tax_Payment_3683.67.pdf' }
  );
  assert.equal(title, 'Matched to 25-06-16_IRS_Tax_Payment_3683.67.pdf · auto-confirmed');
});

await test('matchHeroTitle: confirmed → "Matched to <file> · confirmed"', () => {
  const title = matchHeroTitle(
    { status: 'confirmed' },
    { filename: 'receipt.pdf' }
  );
  assert.equal(title, 'Matched to receipt.pdf · confirmed');
});

await test('matchHeroTitle: suggested → "Matched to <file> · suggested"', () => {
  const title = matchHeroTitle(
    { status: 'suggested' },
    { filename: 'receipt.pdf' }
  );
  assert.equal(title, 'Matched to receipt.pdf · suggested');
});

await test('matchHeroTitle: rejected match → null (hero suppressed)', () => {
  assert.equal(
    matchHeroTitle({ status: 'rejected' }, { filename: 'receipt.pdf' }),
    null
  );
});

await test('matchHeroTitle: missing matched document → null', () => {
  assert.equal(matchHeroTitle({ status: 'confirmed' }, null), null);
});

await test('matchHeroTitle: falls back to original_filename when filename is missing', () => {
  const title = matchHeroTitle(
    { status: 'confirmed' },
    { original_filename: 'orig.pdf' }
  );
  assert.equal(title, 'Matched to orig.pdf · confirmed');
});

// ── docTypeLabel ────────────────────────────────────────────────────

await test('docTypeLabel: known type → mapped label', () => {
  assert.equal(docTypeLabel('supplier_bill'), 'Bill');
  assert.equal(docTypeLabel('sales_invoice'), 'Sales invoice');
  assert.equal(docTypeLabel('payment_confirmation'), 'Payment confirmation');
});

await test('docTypeLabel: unknown type → title-cased fallback (forwards-compat for new types)', () => {
  assert.equal(docTypeLabel('some_new_type'), 'Some New Type');
});

await test('docTypeLabel: empty → empty (caller drops the row)', () => {
  assert.equal(docTypeLabel(''), '');
  assert.equal(docTypeLabel(null), '');
});

// ── matchHeroFields ─────────────────────────────────────────────────

await test('matchHeroFields: payment_confirmation matched to IRS row → counterparty/type/amount/date', () => {
  const doc = {
    document_type: 'payment_confirmation',
    filename: '25-06-16_IRS_Tax_Payment_3683.67.pdf',
    total_amount: 3683.67,
    currency: 'USD',
    document_date: '2025-06-16'
  };
  const match = { status: 'auto_matched', match_amount: 3683.67, match_currency: 'USD' };
  const fields = matchHeroFields(doc, match);
  assert.deepEqual(
    fields.map((f) => f.label),
    ['Counterparty', 'Type', 'Amount', 'Date']
  );
  // Counterparty comes from the IRS-style filename convention.
  assert.match(fields[0].value, /IRS/);
  assert.equal(fields[1].value, 'Payment confirmation');
  assert.match(fields[2].value, /^USD\s3,683\.67$/);
  assert.equal(fields[3].value, 'Jun 16, 2025');
});

await test('matchHeroFields: receipt with vendor_name → renders the supplier as counterparty', () => {
  const doc = {
    document_type: 'receipt',
    vendor_name: 'Acme Coffee',
    total_amount: 12.5,
    currency: 'EUR',
    document_date: '2026-01-15'
  };
  const fields = matchHeroFields(doc, { status: 'confirmed' });
  assert.equal(fields[0].value, 'Acme Coffee');
  assert.equal(fields[1].value, 'Receipt');
  assert.match(fields[2].value, /^EUR\s12\.50$/);
  assert.equal(fields[3].value, 'Jan 15, 2026');
});

await test('matchHeroFields: sales_invoice reads customer_name (not vendor_name) for counterparty', () => {
  const doc = {
    document_type: 'sales_invoice',
    customer_name: 'Beta Corp',
    total_amount: 1500,
    currency: 'EUR',
    issue_date: '2026-03-01'
  };
  const fields = matchHeroFields(doc, { status: 'confirmed' });
  assert.equal(fields[0].value, 'Beta Corp');
  assert.equal(fields[1].value, 'Sales invoice');
});

await test('matchHeroFields: match.match_amount overrides doc.total_amount when both exist (settled amount wins)', () => {
  const doc = {
    document_type: 'sales_invoice',
    customer_name: 'Beta Corp',
    total_amount: 5000,
    currency: 'EUR'
  };
  const match = { status: 'auto_matched', match_amount: 2500 };
  const fields = matchHeroFields(doc, match);
  const amountField = fields.find((f) => f.label === 'Amount');
  assert.match(amountField.value, /^EUR\s2,500$/);
});

await test('matchHeroFields: missing amount + currency → Amount row drops', () => {
  const doc = {
    document_type: 'receipt',
    vendor_name: 'Acme'
  };
  const fields = matchHeroFields(doc, { status: 'confirmed' });
  assert.equal(fields.find((f) => f.label === 'Amount'), undefined);
});

await test('matchHeroFields: pg Date instance for document_date → formats cleanly (no "Invalid Date")', () => {
  // pg returns DATE columns as Date instances by default — the same
  // shape that broke matchExplanation.js (#197). Repeat the regression
  // guard for the hero's date formatter so we don't re-introduce it.
  const doc = {
    document_type: 'receipt',
    vendor_name: 'Acme',
    document_date: new Date('2025-06-16T00:00:00Z')
  };
  const fields = matchHeroFields(doc, { status: 'confirmed' });
  const dateField = fields.find((f) => f.label === 'Date');
  assert.equal(dateField.value, 'Jun 16, 2025');
});

await test('matchHeroFields: missing matched document and no receipt data → empty array', () => {
  assert.deepEqual(matchHeroFields(null, { status: 'confirmed' }), []);
});

await test('matchHeroFields: unresolvable document degrades to the match receipt + bank line (never blank)', () => {
  // The land-lease dead zone (2026-08-16): the line was auto_matched and
  // settled, but the doc object didn't resolve client-side, and the hero
  // rendered nothing — a reconciled material line presenting as
  // "no evidence". The receipt (match_amount/currency) and the bank line
  // still carry renderable facts; render them.
  const match = { status: 'auto_matched', match_amount: 865.13, match_currency: 'USD' };
  const tx = { description: 'LAND LEASE PMT ACH 719531', money_out: 865.13 };
  const fields = matchHeroFields(null, match, tx);
  const byLabel = Object.fromEntries(fields.map((f) => [f.label, f.value]));
  assert.equal(byLabel.Counterparty, 'LAND LEASE PMT', 'bank-line counterparty, rail/ref tokens stripped');
  assert.match(byLabel.Amount, /^USD\s865\.13$/, 'the settled match_amount + its currency');
});

await test('matchHeroFields: unresolvable document with no match_amount falls back to the bank line amount', () => {
  const match = { status: 'suggested' };
  const tx = { description: 'SHOPIFY INC ACH 889512', money_in: 2283.87, currency: 'USD' };
  const fields = matchHeroFields(null, match, tx);
  const byLabel = Object.fromEntries(fields.map((f) => [f.label, f.value]));
  assert.equal(byLabel.Counterparty, 'SHOPIFY INC');
  assert.match(byLabel.Amount, /^USD\s2,283\.87$/);
});

await test('matchHeroFields: sparse evidence doc falls back to the bank line for counterparty/amount/currency', () => {
  // The Shopify-payout case: the client uploaded a settlement report that
  // extracted with no vendor, no total, no currency. The bank line (the same
  // economic event) names the counterparty and amount reliably — use it
  // instead of "Unknown vendor" / a dropped amount row.
  const doc = { document_type: 'receipt', filename: 'Honeybee_Shopify_Payout.pdf' };
  const match = { status: 'auto_matched', match_amount: 0 }; // 0 == no settled amount captured
  const tx = { description: 'SHOPIFY INC ACH 889512', money_in: 2283.87, money_out: 0, currency: 'USD' };
  const fields = matchHeroFields(doc, match, tx);
  const byLabel = Object.fromEntries(fields.map((f) => [f.label, f.value]));
  assert.equal(byLabel.Counterparty, 'SHOPIFY INC', 'bank-line counterparty stands in for the empty doc vendor');
  assert.match(byLabel.Amount, /^USD\s2,283\.87$/, 'bank-line amount + currency stand in for the empty doc total');
});

await test('matchHeroFields: a real match_amount still wins over the bank line', () => {
  const doc = { document_type: 'receipt', vendor_name: 'Acme', total_amount: 50, currency: 'USD' };
  const match = { status: 'confirmed', match_amount: 49.5 };
  const tx = { description: 'ACME', money_out: 49.5, currency: 'USD' };
  const fields = matchHeroFields(doc, match, tx);
  const byLabel = Object.fromEntries(fields.map((f) => [f.label, f.value]));
  assert.equal(byLabel.Counterparty, 'Acme', 'a real doc vendor is untouched');
  assert.match(byLabel.Amount, /^USD\s49\.50$/, 'the settled match_amount wins');
});

// ── shouldSuppressProactiveAskClient ─────────────────────────────────

await test('shouldSuppressProactiveAskClient: meaningful match → true (hide the stale ask-client card)', () => {
  assert.equal(shouldSuppressProactiveAskClient({ status: 'auto_matched' }), true);
  assert.equal(shouldSuppressProactiveAskClient({ status: 'confirmed' }), true);
  assert.equal(shouldSuppressProactiveAskClient({ status: 'suggested' }), true);
});

await test('shouldSuppressProactiveAskClient: no match → false (keep the categorization-side ask-client)', () => {
  assert.equal(shouldSuppressProactiveAskClient(null), false);
});

await test('shouldSuppressProactiveAskClient: rejected match → false (rejection means firm explicitly said no document evidence)', () => {
  assert.equal(shouldSuppressProactiveAskClient({ status: 'rejected' }), false);
});

// ── matchHeroReasoning ───────────────────────────────────────────────

await test('matchHeroReasoning: LLM match → reasoning + hops + clamped confidence from payload.match_reason', () => {
  const match = {
    status: 'suggested',
    match_confidence: 0.52,
    match_reason: 'EUR 787.54 ≈ GBP 745 × FX — but payer is a different counterparty.',
    payload: {
      match_reason: {
        reasoning: 'EUR 787.54 ≈ GBP 745 × FX — but payer is a different counterparty.',
        hops: ['fx_conversion_GBP_EUR', 'amount_near', ''],
        confidence: 1.4
      }
    }
  };
  const out = matchHeroReasoning(match);
  assert.equal(out.reasoning, 'EUR 787.54 ≈ GBP 745 × FX — but payer is a different counterparty.');
  assert.deepEqual(out.hops, ['fx_conversion_GBP_EUR', 'amount_near'], 'empty hop dropped');
  assert.equal(out.confidence, 1, 'confidence clamped to 1');
});

await test('matchHeroReasoning: text-only match_reason column → reasoning from string, confidence from match_confidence', () => {
  const out = matchHeroReasoning({
    status: 'suggested',
    match_confidence: 0.72,
    match_reason: 'Stripe payout settles this invoice via FX.'
  });
  assert.equal(out.reasoning, 'Stripe payout settles this invoice via FX.');
  assert.deepEqual(out.hops, []);
  assert.equal(out.confidence, 0.72);
});

await test('matchHeroReasoning: weighted match (no reasoning, no hops) → null (block drops out)', () => {
  const out = matchHeroReasoning({
    status: 'suggested',
    match_confidence: 0.8,
    payload: { match_reason: { amount: { exact: true }, hints: ['vendor_exact'], score: 0.8 } }
  });
  assert.equal(out, null);
});

await test('matchHeroReasoning: null match → null', () => {
  assert.equal(matchHeroReasoning(null), null);
});

await test('matchHeroReasoning: surfaces hops even when reasoning is empty', () => {
  const out = matchHeroReasoning({
    status: 'auto_matched',
    payload: { match_reason: { hops: ['processor:stripe', 'settlement_lag_3d'] } }
  });
  assert.deepEqual(out.hops, ['processor:stripe', 'settlement_lag_3d']);
  assert.equal(out.reasoning, '');
  assert.equal(out.confidence, null, 'no confidence anywhere → null');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
