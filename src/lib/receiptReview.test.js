// Smoke tests for the receipt-reconciliation review helpers
// (Reconciliation PR 4). Pure-function assertions; no DOM, no React,
// no JSDOM — mirrors `uploadTray.test.js`.

import {
  allowedActionsFor,
  autoExplainHintFor,
  buildActionTelemetry,
  buildPatchForAction,
  buildReviewBuckets,
  buildReviewRow,
  classifierSummaryFor,
  evidenceIndicatorFor,
  formatClassifierChip,
  requiresConfirmPrompt,
  reviewStatusChip,
  telemetryHasPii,
  undoTargetStatus
} from './receiptReview.js';
import { AUTO_EXPLAIN_BLOCKERS } from './receiptAutoExplainBlockers.js';

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  fail ${name}`);
    console.error(`       ${err?.message || err}`);
  }
};

const assertEqual = (actual, expected, label) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const assertDeepEqual = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label}: expected ${b}, got ${a}`);
  }
};

const assertTrue = (value, label) => {
  if (!value) throw new Error(`${label}: expected truthy, got ${JSON.stringify(value)}`);
};

const assertFalse = (value, label) => {
  if (value) throw new Error(`${label}: expected falsy, got ${JSON.stringify(value)}`);
};

const receiptMatch = (overrides = {}) => ({
  id: 'm1',
  status: 'suggested',
  bank_transaction_id: 'tx1',
  matched_object_type: 'document',
  matched_object_id: 'doc1',
  match_confidence: 0.9,
  match_reason: 'amount_date_match',
  created_at: '2026-05-10T09:00:00.000Z',
  updated_at: '2026-05-10T09:00:00.000Z',
  payload: { source: 'receipt_reconciliation' },
  ...overrides
});

const safeReceiptDoc = (overrides = {}) => ({
  id: 'doc1',
  document_type: 'receipt',
  parse_summary: {
    semantic: {
      expense_kind: 'taxi',
      confidence_band: 'high',
      evidence_sufficient_signal: true,
      used_fallback: false,
      is_safe_list: true,
      warnings: []
    }
  },
  ...overrides
});

const baseTx = (overrides = {}) => ({
  id: 'tx1',
  date: '2026-05-09',
  description: 'Taxi ride',
  money_in: 0,
  money_out: 12.5,
  account_currency: 'EUR',
  reconciliation_status: 'needs_review',
  ...overrides
});

console.log('receiptReview:');

// === Bucket splitting (1–3) ===

test('1: auto_matched rows land in auto_matched_to_review', () => {
  const matches = [
    receiptMatch({ id: 'a', status: 'auto_matched', bank_transaction_id: 'txA', matched_object_id: 'docA' }),
    receiptMatch({ id: 'b', status: 'auto_matched', bank_transaction_id: 'txB', matched_object_id: 'docB' }),
    receiptMatch({ id: 'c', status: 'suggested', bank_transaction_id: 'txC', matched_object_id: 'docC' }),
    receiptMatch({ id: 'd', status: 'confirmed', bank_transaction_id: 'txD', matched_object_id: 'docD' })
  ];
  const documents = ['docA', 'docB', 'docC', 'docD'].map((id) => safeReceiptDoc({ id }));
  const transactions = ['txA', 'txB', 'txC', 'txD'].map((id) => baseTx({ id }));
  const buckets = buildReviewBuckets({ reconciliationMatches: matches, documents, transactions });
  assertEqual(buckets.auto_matched_to_review.length, 2, 'auto_matched count');
  buckets.auto_matched_to_review.forEach((row) =>
    assertEqual(row.status, 'auto_matched', 'auto_matched row status'));
});

test('2: suggested rows stay in suggested_review', () => {
  const matches = [
    receiptMatch({ id: 's1', status: 'suggested', bank_transaction_id: 'tx1', matched_object_id: 'd1' }),
    receiptMatch({ id: 's2', status: 'suggested', bank_transaction_id: 'tx2', matched_object_id: 'd2' })
  ];
  const documents = ['d1', 'd2'].map((id) => safeReceiptDoc({ id }));
  const transactions = ['tx1', 'tx2'].map((id) => baseTx({ id }));
  const buckets = buildReviewBuckets({ reconciliationMatches: matches, documents, transactions });
  assertEqual(buckets.suggested_review.length, 2, 'suggested count');
  assertEqual(buckets.auto_matched_to_review.length, 0, 'auto_matched empty');
});

test('3: confirmed and rejected rows land in their archive buckets', () => {
  const matches = [
    receiptMatch({ id: 'cf', status: 'confirmed', bank_transaction_id: 'tx1', matched_object_id: 'd1' }),
    receiptMatch({ id: 'rj', status: 'rejected', bank_transaction_id: 'tx2', matched_object_id: 'd2' })
  ];
  const documents = ['d1', 'd2'].map((id) => safeReceiptDoc({ id }));
  const transactions = ['tx1', 'tx2'].map((id) => baseTx({ id }));
  const buckets = buildReviewBuckets({ reconciliationMatches: matches, documents, transactions });
  assertEqual(buckets.confirmed_handled.length, 1, 'confirmed count');
  assertEqual(buckets.rejected_archived.length, 1, 'rejected count');
  assertEqual(buckets.confirmed_handled[0].status, 'confirmed', 'confirmed status');
  assertEqual(buckets.rejected_archived[0].status, 'rejected', 'rejected status');
});

// === Visual states (4–8) ===

test('4: status chip resolves correctly per status', () => {
  assertEqual(reviewStatusChip({ status: 'auto_matched' }), 'auto_matched', 'auto chip');
  assertEqual(reviewStatusChip({ status: 'suggested' }), 'suggested', 'suggested chip');
  assertEqual(reviewStatusChip({ status: 'confirmed' }), 'confirmed', 'confirmed chip');
  assertEqual(reviewStatusChip({ status: 'rejected' }), 'rejected', 'rejected chip');
});

test('5: allowed actions match the status', () => {
  assertDeepEqual(allowedActionsFor({ status: 'auto_matched' }), ['confirm', 'undo', 'reject'], 'auto actions');
  assertDeepEqual(allowedActionsFor({ status: 'suggested' }), ['confirm', 'reject'], 'suggested actions');
  assertDeepEqual(allowedActionsFor({ status: 'confirmed' }), [], 'confirmed terminal');
  assertDeepEqual(allowedActionsFor({ status: 'rejected' }), [], 'rejected terminal');
});

test('6: classifier chip is a hint, never a conclusion', () => {
  const summary = classifierSummaryFor(safeReceiptDoc());
  assertEqual(summary.expense_kind, 'taxi', 'expense_kind');
  assertEqual(summary.confidence_band, 'high', 'confidence_band');
  const chipText = formatClassifierChip(summary);
  assertEqual(chipText, 'Taxi · high confidence', 'chip copy is hint not conclusion');
  // explicit guard: NEVER renders as a declarative claim
  assertFalse(chipText.toLowerCase().includes('this is'), 'no "This is" framing');
  assertFalse(chipText.toLowerCase().includes('expense'), 'no "expense" verbiage');
});

test('7: empty classifier degrades silently', () => {
  assertEqual(classifierSummaryFor({}), null, 'empty doc');
  assertEqual(classifierSummaryFor({ parse_summary: {} }), null, 'empty parse_summary');
  assertEqual(classifierSummaryFor({ parse_summary: { semantic: {} } }), null, 'semantic without kind');
  const fallback = classifierSummaryFor({
    parse_summary: {
      semantic: { expense_kind: 'taxi', used_fallback: true, confidence_band: 'low' }
    }
  });
  assertTrue(fallback, 'fallback summary present');
  assertEqual(fallback.used_fallback, true, 'used_fallback flagged');
});

test('8: blocker hint is diagnostic', () => {
  const hint = autoExplainHintFor({
    payload: { auto_explain_blockers: [AUTO_EXPLAIN_BLOCKERS.EXPENSE_KIND_CAUTIOUS] }
  });
  assertEqual(hint, 'Auto-explain skipped: cautious category', 'cautious copy');
  // copy must NOT carry warning vocabulary (hard invariant 6)
  assertFalse(hint.toLowerCase().includes('warning'), 'no warning vocab');
  assertFalse(hint.toLowerCase().includes('error'), 'no error vocab');
  assertFalse(hint.toLowerCase().includes('blocked'), 'no blocked vocab');
});

// === Action correctness (9–12) ===

test('9: confirm action targets confirmed', () => {
  const patch = buildPatchForAction({
    action: 'confirm',
    match: receiptMatch({ status: 'auto_matched' })
  });
  assertDeepEqual(patch, { status: 'confirmed' }, 'confirm patch');
});

test('10: reject action targets rejected and requires confirm prompt', () => {
  const patch = buildPatchForAction({
    action: 'reject',
    match: receiptMatch({ status: 'suggested' })
  });
  assertDeepEqual(patch, { status: 'rejected' }, 'reject patch');
  assertEqual(requiresConfirmPrompt('reject'), true, 'reject needs prompt');
  assertEqual(requiresConfirmPrompt('confirm'), false, 'confirm no prompt');
  assertEqual(requiresConfirmPrompt('undo'), false, 'undo no prompt');
});

test('11: undo action targets suggested', () => {
  const patch = buildPatchForAction({
    action: 'undo',
    match: receiptMatch({ status: 'auto_matched' })
  });
  assertDeepEqual(patch, { status: 'suggested' }, 'undo patch');
});

test('12: telemetry payload is PII-safe', () => {
  const payload = buildActionTelemetry({
    action: 'confirm',
    match: receiptMatch({ status: 'auto_matched' }),
    document: safeReceiptDoc({
      vendor_name: 'Acme Taxi Co',
      merchant_display_name: 'Acme Taxi',
      reference_number: 'INV-12345',
      description: 'Late-night ride home',
      business_purpose_guess: 'client meeting'
    })
  });
  assertEqual(payload.event, 'reconciliation_review.action_clicked', 'event name');
  assertEqual(payload.action, 'confirm', 'action');
  assertEqual(payload.prev_status, 'auto_matched', 'prev_status');
  assertEqual(payload.next_status, 'confirmed', 'next_status');
  assertEqual(payload.has_classifier_metadata, true, 'has_classifier_metadata');
  assertEqual(payload.expense_kind_band, 'high', 'expense_kind_band');
  assertFalse(telemetryHasPii(payload), 'no PII fields');
  // exhaustive: ensure NONE of the PII fields landed
  const piiKeys = ['vendor_name', 'merchant_display_name', 'reference_number', 'description', 'business_purpose_guess'];
  piiKeys.forEach((key) =>
    assertFalse(Object.prototype.hasOwnProperty.call(payload, key), `payload has no ${key}`)
  );
});

// === Row stability + snapshot consistency (13–15) ===

test('13: row order is deterministic across shuffles', () => {
  const matches = [
    receiptMatch({ id: 'a', status: 'suggested', bank_transaction_id: 'tx1', matched_object_id: 'd1', created_at: '2026-05-01T00:00:00.000Z' }),
    receiptMatch({ id: 'b', status: 'suggested', bank_transaction_id: 'tx2', matched_object_id: 'd2', created_at: '2026-05-02T00:00:00.000Z' }),
    receiptMatch({ id: 'c', status: 'suggested', bank_transaction_id: 'tx3', matched_object_id: 'd3', created_at: '2026-05-03T00:00:00.000Z' })
  ];
  const documents = ['d1', 'd2', 'd3'].map((id) => safeReceiptDoc({ id }));
  const transactions = ['tx1', 'tx2', 'tx3'].map((id) => baseTx({ id }));
  const orderForward = buildReviewBuckets({
    reconciliationMatches: matches,
    documents,
    transactions
  }).suggested_review.map((row) => row.id);
  const orderReverse = buildReviewBuckets({
    reconciliationMatches: [...matches].reverse(),
    documents,
    transactions
  }).suggested_review.map((row) => row.id);
  assertDeepEqual(orderForward, ['a', 'b', 'c'], 'forward order');
  assertDeepEqual(orderReverse, ['a', 'b', 'c'], 'reverse-input still sorts to same order');
});

test('14: missing document or transaction → null row', () => {
  assertEqual(buildReviewRow({ match: receiptMatch(), document: null, transaction: baseTx() }), null, 'null doc');
  assertEqual(buildReviewRow({ match: receiptMatch(), document: safeReceiptDoc(), transaction: null }), null, 'null tx');
  assertEqual(buildReviewRow({ match: null, document: safeReceiptDoc(), transaction: baseTx() }), null, 'null match');
});

test('15: undoTargetStatus returns null for non-auto_matched rows', () => {
  assertEqual(undoTargetStatus({ status: 'suggested' }), null, 'suggested no undo');
  assertEqual(undoTargetStatus({ status: 'confirmed' }), null, 'confirmed no undo');
  assertEqual(undoTargetStatus({ status: 'rejected' }), null, 'rejected no undo');
  assertEqual(undoTargetStatus({ status: 'auto_matched' }), 'suggested', 'auto → suggested');
});

// === Edge cases (16–20) ===

test('16: classifier fallback renders with (fallback) qualifier', () => {
  const summary = classifierSummaryFor({
    parse_summary: {
      semantic: { expense_kind: 'office_supplies', confidence_band: 'medium', used_fallback: true }
    }
  });
  const chip = formatClassifierChip(summary);
  assertEqual(chip, 'Office Supplies · medium confidence (fallback)', 'fallback qualifier rendered');
});

test('17: cautious-list expense_kind on suggested row keeps the chip but no auto-explained status', () => {
  const cautiousDoc = safeReceiptDoc({
    parse_summary: {
      semantic: { expense_kind: 'restaurant_cafe', confidence_band: 'high', is_safe_list: false }
    }
  });
  const summary = classifierSummaryFor(cautiousDoc);
  assertTrue(summary, 'classifier chip present');
  assertEqual(summary.is_safe_list, false, 'is_safe_list false');
  const match = receiptMatch({
    status: 'suggested',
    payload: {
      source: 'receipt_reconciliation',
      auto_explain_blockers: [AUTO_EXPLAIN_BLOCKERS.EXPENSE_KIND_CAUTIOUS]
    }
  });
  assertEqual(reviewStatusChip(match), 'suggested', 'still suggested chip');
  assertEqual(autoExplainHintFor(match), 'Auto-explain skipped: cautious category', 'cautious hint');
});

test('18: missing auto_explain_blockers → empty string (not null/undefined)', () => {
  const hint = autoExplainHintFor({ payload: {} });
  assertEqual(hint, '', 'no blockers payload');
  assertEqual(typeof hint, 'string', 'always a string');
  assertEqual(autoExplainHintFor({}), '', 'no payload at all');
  assertEqual(autoExplainHintFor(null), '', 'null match');
  assertEqual(autoExplainHintFor({ payload: { auto_explain_blockers: [] } }), '', 'empty array');
});

test('19: non-receipt-reconciliation match sources are excluded from all buckets', () => {
  const matches = [
    receiptMatch({ id: 'r', status: 'suggested' }),
    {
      id: 'other',
      status: 'suggested',
      bank_transaction_id: 'tx2',
      matched_object_type: 'document',
      matched_object_id: 'd2',
      payload: { source: 'manual_link' }
    },
    {
      id: 'no-source',
      status: 'auto_matched',
      bank_transaction_id: 'tx3',
      matched_object_type: 'document',
      matched_object_id: 'd3',
      payload: {}
    }
  ];
  const documents = ['doc1', 'd2', 'd3'].map((id) => safeReceiptDoc({ id }));
  const transactions = ['tx1', 'tx2', 'tx3'].map((id) => baseTx({ id }));
  const buckets = buildReviewBuckets({ reconciliationMatches: matches, documents, transactions });
  const allIds = [
    ...buckets.auto_matched_to_review,
    ...buckets.suggested_review,
    ...buckets.confirmed_handled,
    ...buckets.rejected_archived
  ].map((row) => row.id);
  assertDeepEqual(allIds, ['r'], 'only the receipt-source match was bucketed');
});

test('20: reviewStatusChip enum is exhaustive', () => {
  const known = ['auto_matched', 'suggested', 'confirmed', 'rejected'];
  known.forEach((status) => {
    const chip = reviewStatusChip({ status });
    assertTrue(known.includes(chip), `chip for ${status} is one of ${known.join(',')}`);
  });
  // unknown / undefined defaults to 'suggested' (safe fallback, never undefined)
  assertEqual(reviewStatusChip({ status: 'unknown_status' }), 'suggested', 'unknown maps to suggested');
  assertEqual(reviewStatusChip({}), 'suggested', 'no status maps to suggested');
  assertEqual(reviewStatusChip(null), 'suggested', 'null maps to suggested');
});

// === Bonus coverage for evidence indicator (helper used by JSX, simple to assert) ===
test('bonus: evidence indicator copy', () => {
  assertEqual(evidenceIndicatorFor({ evidence_sufficient: true }), 'Evidence: sufficient', 'sufficient copy');
  assertEqual(evidenceIndicatorFor({ evidence_sufficient: false }), 'Evidence: needs context', 'needs-context copy');
  assertEqual(evidenceIndicatorFor(null), null, 'null when no summary');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
