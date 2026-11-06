import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECEIPT_FAILURE_TTL_MS,
  RECEIPT_SUCCESS_TTL_MS,
  foldApplyOutcomeIntoReceipts,
  foldFeedEventsIntoReceipts,
  hasFeedChanges,
  pruneReceipts
} from './feedEventsTick.js';

test('hasFeedChanges: false on a bootstrap/empty payload, true per leg', () => {
  assert.equal(hasFeedChanges({}), false);
  assert.equal(hasFeedChanges({ events: [], documents: [], transactions: [] }), false);
  assert.equal(hasFeedChanges({ events: [{ id: 1 }] }), true);
  assert.equal(hasFeedChanges({ documents: [{ id: 'doc-1' }] }), true);
  assert.equal(hasFeedChanges({ transactions: [{ id: 'tx-1' }] }), true);
});

test('fold recode_decided: resolves the review item to its transaction and carries the split state', () => {
  const events = [{
    id: 10,
    action: 'review.recode_decided',
    resource_id: 'item-1',
    metadata: {
      account_name: 'Marketing',
      from_review_state: 'accepted',
      ledger_adjustment_required: true,
      original_journal_id: 'jrn-1'
    }
  }];
  const receipts = foldFeedEventsIntoReceipts({}, events, {
    resolveReviewItemTransactionId: (id) => (id === 'item-1' ? 'tx-7' : null),
    now: 1000
  });
  assert.deepEqual(receipts['tx-7'], {
    kind: 'ledger_pending',
    ledger_pending: true,
    account_name: 'Marketing',
    original_journal_id: 'jrn-1',
    source: 'audit:review.recode_decided',
    received_at: 1000
  });
});

test('fold recode_decided: unresolvable review item is skipped, prev returned by identity', () => {
  const prev = {};
  const events = [{ id: 11, action: 'review.recode_decided', resource_id: 'item-x', metadata: {} }];
  const receipts = foldFeedEventsIntoReceipts(prev, events, {
    resolveReviewItemTransactionId: () => null,
    now: 1000
  });
  assert.equal(receipts, prev);
});

test('fold adjustment_posted: clears a pending receipt for the same transaction', () => {
  const prev = {
    'tx-7': { kind: 'ledger_pending', ledger_pending: true, source: 'apply-receipt', received_at: 500 }
  };
  const events = [{
    id: 12,
    action: 'ledger.adjustment_posted',
    resource_id: 'jrn-9',
    metadata: { transaction_id: 'tx-7', original_journal_id: 'jrn-1' }
  }];
  const receipts = foldFeedEventsIntoReceipts(prev, events, { now: 2000 });
  assert.equal(receipts['tx-7'].kind, 'ledger_adjusted');
  assert.equal(receipts['tx-7'].ledger_pending, false);
  assert.equal(receipts['tx-7'].original_journal_id, 'jrn-1');
  // prev untouched (fold copies)
  assert.equal(prev['tx-7'].ledger_pending, true);
});

test('fold feed_chat_apply: per-row failures land per transaction; successes are not receipted here', () => {
  const events = [{
    id: 13,
    action: 'transaction.feed_chat_apply',
    resource_id: 'msg-1',
    metadata: {
      action_type: 'apply_category',
      requested: 3,
      applied: 2,
      failed: 1,
      errors: [{ transaction_id: 'tx-22', error: 'no_review_item' }]
    }
  }];
  const receipts = foldFeedEventsIntoReceipts({}, events, { now: 3000 });
  assert.deepEqual(Object.keys(receipts), ['tx-22']);
  assert.equal(receipts['tx-22'].kind, 'apply_failed');
  assert.equal(receipts['tx-22'].error, 'no_review_item');
});

test('fold: irrelevant events return prev by identity', () => {
  const prev = { 'tx-1': { kind: 'applied', ledger_pending: false, received_at: 1 } };
  const events = [{ id: 14, action: 'chat.proposal_minted', metadata: {} }];
  assert.equal(foldFeedEventsIntoReceipts(prev, events, { now: 1 }), prev);
  assert.equal(foldFeedEventsIntoReceipts(prev, [], { now: 1 }), prev);
});

test('foldApplyOutcome: pending / reclassed / failed / clean rows map to their receipt kinds', () => {
  const results = [
    {
      transaction_id: 'tx-1',
      applied: true,
      posting: { step: 'ledger_adjustment_required', status: 'pending', reason: 'multi_line_journal', original_journal_id: 'jrn-1' }
    },
    {
      transaction_id: 'tx-2',
      applied: true,
      posting: { step: 'ledger_reclass', status: 'posted', original_journal_id: 'jrn-2' }
    },
    { transaction_id: 'tx-3', applied: false, error: 'no_review_item' },
    { transaction_id: 'tx-4', applied: true, posting: { step: 'post', status: 'error', error: 'Posting failed.' } },
    { transaction_id: 'tx-5', applied: true, posting: { step: 'ledger_post', status: 'posted' } }
  ];
  const receipts = foldApplyOutcomeIntoReceipts({}, results, { now: 4000 });
  assert.equal(receipts['tx-1'].kind, 'ledger_pending');
  assert.equal(receipts['tx-1'].ledger_pending, true);
  assert.equal(receipts['tx-1'].reason, 'multi_line_journal');
  assert.equal(receipts['tx-2'].kind, 'ledger_adjusted');
  assert.equal(receipts['tx-3'].kind, 'apply_failed');
  assert.equal(receipts['tx-3'].error, 'no_review_item');
  assert.equal(receipts['tx-4'].kind, 'apply_failed');
  assert.equal(receipts['tx-4'].error, 'Posting failed.');
  assert.equal(receipts['tx-5'].kind, 'applied');
});

test('foldApplyOutcome: empty / id-less rows return prev by identity', () => {
  const prev = {};
  assert.equal(foldApplyOutcomeIntoReceipts(prev, [], { now: 1 }), prev);
  assert.equal(foldApplyOutcomeIntoReceipts(prev, [{ applied: true }], { now: 1 }), prev);
});

test('prune: success receipts expire, failures outlive them, ledger_pending never expires', () => {
  const base = {
    ok: { kind: 'applied', ledger_pending: false, received_at: 0 },
    failed: { kind: 'apply_failed', ledger_pending: false, received_at: 0 },
    pending: { kind: 'ledger_pending', ledger_pending: true, received_at: 0 }
  };
  const afterSuccessTtl = pruneReceipts(base, { now: RECEIPT_SUCCESS_TTL_MS });
  assert.deepEqual(Object.keys(afterSuccessTtl).sort(), ['failed', 'pending']);

  const afterFailureTtl = pruneReceipts(base, { now: RECEIPT_FAILURE_TTL_MS });
  assert.deepEqual(Object.keys(afterFailureTtl), ['pending']);

  // Nothing expired → identity, so React state setters can no-op.
  const fresh = { ok: { kind: 'applied', ledger_pending: false, received_at: 100 } };
  assert.equal(pruneReceipts(fresh, { now: 101 }), fresh);
  const empty = {};
  assert.equal(pruneReceipts(empty, { now: 1 }), empty);
});
