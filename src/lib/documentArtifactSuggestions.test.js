// Document artifact suggestions — unit tests.
//
// Pins the contract the artifact UI depends on:
//   - hasParsedMatchingData gates rendering of Suggested Matches
//   - suggestedMatches only includes credible, high-confidence
//     candidates that pass ALL gates (threshold + same currency +
//     compatible direction + not resolved + at least one strong
//     signal)
//   - searchResults is the broad fallback pool (always populated,
//     even when parse failed) with the chips that excluded each row
//     from suggestions
//   - formatTransactionDate never returns raw ISO

import assert from 'node:assert/strict';

import {
  buildSuggestedMatches,
  formatTransactionDate,
  hasParsedMatchingData,
  isLinkableDocumentType,
  SUGGESTION_SCORE_THRESHOLD
} from './documentArtifactSuggestions.js';

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

const RECEIPT_DOC = {
  id: 'doc-r1',
  document_type: 'receipt',
  vendor_name: 'Cabify',
  total_amount: 18.40,
  currency: 'EUR',
  document_date: '2026-04-30'
};

const txFixture = (overrides = {}) => ({
  id: 'tx-1',
  money_out: 18.40,
  money_in: 0,
  currency: 'EUR',
  transaction_date: '2026-04-30',
  description: 'CABIFY ESP MADRID',
  raw_description: 'CABIFY ESP MADRID 18,40 EUR',
  reconciliation_status: null,
  ...overrides
});

console.log('documentArtifactSuggestions:');

// ─── hasParsedMatchingData ───────────────────────────────────────────────

await test('hasParsedMatchingData: any of total / date / counterparty is enough', () => {
  // Partial extraction is still useful — scoring degrades gracefully
  // when one signal is missing. Only the all-three-missing case is
  // the parse-empty state.
  assert.equal(hasParsedMatchingData({ total_amount: 100 }), true);
  assert.equal(hasParsedMatchingData({ document_date: '2026-01-01' }), true);
  assert.equal(hasParsedMatchingData({ vendor_name: 'X' }), true);
  assert.equal(hasParsedMatchingData({ document_type: 'sales_invoice', customer_name: 'Y' }), true);
  assert.equal(hasParsedMatchingData({}), false);
  assert.equal(hasParsedMatchingData({ total_amount: null, document_date: null, vendor_name: null }), false);
  assert.equal(hasParsedMatchingData(null), false);
});

// ─── Bucket separation: suggestions vs. searchResults ────────────────────

await test('null document → hasParsedMatchingData=false, both buckets empty', () => {
  const out = buildSuggestedMatches({ document: null, transactions: [txFixture()] });
  assert.equal(out.hasParsedMatchingData, false);
  assert.deepEqual(out.suggestedMatches, []);
  assert.deepEqual(out.searchResults, []);
  assert.equal(out.suggestionCount, 0);
  assert.equal(out.searchResultCount, 0);
});

await test('parse-empty doc (no total / no date / no counterparty) → no suggestedMatches, searchResults still populated', () => {
  // Critical product rule: when the doc didn't parse, we don't
  // pretend to suggest anything — but we still let the firm search
  // manually if they KNOW which tx the doc pays.
  const noParseDoc = { id: 'doc-bad', document_type: 'receipt' };
  const out = buildSuggestedMatches({
    document: noParseDoc,
    transactions: [
      txFixture({ id: 'tx-a' }),
      txFixture({ id: 'tx-b', money_out: 50, description: 'GENERIC' })
    ]
  });
  assert.equal(out.hasParsedMatchingData, false);
  assert.deepEqual(out.suggestedMatches, [], 'no suggestions for unparseable doc');
  assert.ok(out.searchResults.length >= 2, 'searchResults still populated so manual search works');
  assert.equal(out.suggestionCount, 0);
  assert.equal(out.searchResultCount, out.searchResults.length);
});

await test('credible same-currency strong-signal tx IS a suggestion', () => {
  const out = buildSuggestedMatches({
    document: RECEIPT_DOC,
    transactions: [txFixture()]
  });
  assert.equal(out.hasParsedMatchingData, true);
  assert.equal(out.suggestedMatches.length, 1);
  assert.equal(out.suggestedMatches[0].transaction.id, 'tx-1');
  assert.ok(out.suggestedMatches[0].score >= SUGGESTION_SCORE_THRESHOLD);
  assert.deepEqual(out.suggestedMatches[0].warnings, [], 'a real suggestion carries no warning chips');
});

await test('different currency → search fallback only (NOT a suggestion)', () => {
  const out = buildSuggestedMatches({
    document: RECEIPT_DOC,
    transactions: [txFixture({ currency: 'USD' })]
  });
  assert.equal(out.suggestedMatches.length, 0);
  assert.equal(out.searchResults.length, 1);
  const row = out.searchResults[0];
  assert.ok(row.warnings.includes('currency_mismatch'), 'currency_mismatch chip on search-only row');
});

await test('wrong direction → search fallback only (NOT a suggestion)', () => {
  // Receipt doc (money_out direction). A money_in tx of the same
  // amount must NEVER be a suggestion but MUST be searchable.
  const out = buildSuggestedMatches({
    document: RECEIPT_DOC,
    transactions: [txFixture({ money_out: 0, money_in: 18.40 })]
  });
  assert.equal(out.suggestedMatches.length, 0);
  assert.equal(out.searchResults.length, 1);
  const row = out.searchResults[0];
  assert.ok(row.warnings.includes('wrong_direction'), 'wrong_direction chip on search-only row');
});

await test('reconciled tx → search fallback only (NOT a suggestion)', () => {
  // The strict pass strips already-reconciled txs; the expanded
  // pass surfaces them with `already_resolved`. They must NEVER be
  // labelled a suggestion — relinking a doc to a reconciled tx
  // requires explicit firm review.
  const out = buildSuggestedMatches({
    document: RECEIPT_DOC,
    transactions: [txFixture({ reconciliation_status: 'reconciled' })]
  });
  assert.equal(out.suggestedMatches.length, 0);
  assert.equal(out.searchResults.length, 1);
  const row = out.searchResults[0];
  assert.ok(row.warnings.includes('already_resolved'), 'already_resolved chip on search-only row');
});

await test('blocked tx (prior firm decision) → search fallback only', () => {
  const out = buildSuggestedMatches({
    document: RECEIPT_DOC,
    transactions: [txFixture()],
    reconciliationMatches: [
      { matched_object_id: 'doc-r1', bank_transaction_id: 'tx-1', status: 'rejected' }
    ]
  });
  assert.equal(out.suggestedMatches.length, 0, 'rejected pair never suggested');
  assert.equal(out.searchResults.length, 1);
  const row = out.searchResults[0];
  assert.equal(row.blocked, true);
  assert.equal(row.blocked_reason, 'prior_decision');
});

await test('weak score (below threshold) → search fallback only', () => {
  // Wrong vendor + wrong amount + same currency + same direction →
  // score lands below 0.70. Strict pass surfaces it; suggestion gate
  // drops it; search results still include it.
  const out = buildSuggestedMatches({
    document: RECEIPT_DOC,
    transactions: [
      txFixture({
        id: 'tx-weak',
        money_out: 100,                     // amount mismatch
        transaction_date: '2025-01-01',     // very different date
        description: 'COMPLETELY UNRELATED',
        raw_description: 'NOTHING MATCHES HERE'
      })
    ]
  });
  assert.equal(out.suggestedMatches.length, 0, 'weak match is never a suggestion');
  assert.equal(out.searchResults.length, 1, 'still in search results');
});

await test('no strong signal (date_close only) → search fallback only', () => {
  // Even if score happened to clear 0.70 (rare without amount /
  // vendor), a candidate with only date_close should not qualify
  // as a suggestion. This pins the strong-signal gate so future
  // scoring changes can't regress it.
  const out = buildSuggestedMatches({
    document: { ...RECEIPT_DOC, total_amount: null },
    transactions: [
      txFixture({
        id: 'tx-date-only',
        money_out: 100,
        transaction_date: '2026-05-02',     // within 7d → date_close
        description: 'NOTHING',
        raw_description: 'NOTHING'
      })
    ]
  });
  assert.equal(out.suggestedMatches.length, 0);
});

await test('suggestedMatches is capped at the limit (default 5)', () => {
  const txs = Array.from({ length: 6 }, (_, i) => txFixture({
    id: `tx-${i}`,
    description: `CABIFY ${i}`,
    raw_description: `CABIFY ESP MADRID ${i}`
  }));
  const out = buildSuggestedMatches({ document: RECEIPT_DOC, transactions: txs });
  assert.equal(out.suggestedMatches.length, 5);
  assert.equal(out.searchResults.length, 6);
});

await test('mixed pool: only the credible tx is a suggestion; all 4 appear in searchResults', () => {
  // Defence-in-depth integration: one strong + one wrong-direction
  // + one different-currency + one reconciled. Exactly one
  // suggestion; all four searchable with their chips.
  const out = buildSuggestedMatches({
    document: RECEIPT_DOC,
    transactions: [
      txFixture({ id: 'tx-strong' }),
      txFixture({ id: 'tx-wrong-dir', money_out: 0, money_in: 18.40 }),
      txFixture({ id: 'tx-fx', currency: 'USD' }),
      txFixture({ id: 'tx-reconciled', reconciliation_status: 'reconciled' })
    ]
  });
  assert.deepEqual(
    out.suggestedMatches.map((c) => c.transaction.id),
    ['tx-strong'],
    'only the credible tx is suggested'
  );
  const searchIds = new Set(out.searchResults.map((c) => c.transaction.id));
  assert.equal(searchIds.size, 4, 'all four pool txs are searchable');
});

// ─── Date formatting ─────────────────────────────────────────────────────

await test('formatTransactionDate: never returns raw ISO', () => {
  // Centralised so the UI can't accidentally render raw ISO. The
  // artifact's CandidateCard goes through this helper.
  const out = formatTransactionDate('2026-04-30');
  assert.ok(!/^\d{4}-\d{2}-\d{2}/.test(out), 'output is not a raw ISO date');
  assert.ok(out.includes('Apr'), 'output contains short month label');
  assert.ok(out.includes('2026'), 'output contains the year');
});

await test('formatTransactionDate: handles full ISO timestamps', () => {
  const out = formatTransactionDate('2026-04-30T14:25:00Z');
  assert.ok(!out.startsWith('2026-'), 'not raw ISO');
  assert.ok(out.includes('Apr'));
});

await test('formatTransactionDate: returns em-dash on missing/invalid input', () => {
  assert.equal(formatTransactionDate(null), '—');
  assert.equal(formatTransactionDate(''), '—');
  assert.equal(formatTransactionDate(undefined), '—');
  assert.equal(formatTransactionDate('not-a-date'), '—');
});

// ─── Allowlist ───────────────────────────────────────────────────────────

await test('isLinkableDocumentType allowlist', () => {
  assert.equal(isLinkableDocumentType('receipt'), true);
  assert.equal(isLinkableDocumentType('supplier_bill'), true);
  assert.equal(isLinkableDocumentType('sales_invoice'), true);
  assert.equal(isLinkableDocumentType('contract'), true);
  assert.equal(isLinkableDocumentType('bank_statement'), false);
  assert.equal(isLinkableDocumentType('plan'), false);
  assert.equal(isLinkableDocumentType('unknown'), false);
  assert.equal(isLinkableDocumentType(null), false);
  assert.equal(isLinkableDocumentType(undefined), false);
});

console.log(`\ndocumentArtifactSuggestions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
