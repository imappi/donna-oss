import assert from 'node:assert/strict';

import { deriveTransactionReviewState, normalizeTransactionReviewState } from './firmDb.js';

assert.equal(normalizeTransactionReviewState('asked client'), 'asked_client');
assert.equal(normalizeTransactionReviewState('needs_client'), 'waiting');
assert.equal(normalizeTransactionReviewState('xero_synced'), 'synced');
assert.equal(normalizeTransactionReviewState('ledger_posted'), 'posted');
assert.equal(normalizeTransactionReviewState('nope'), null);

assert.equal(deriveTransactionReviewState({ payload: {} }), 'suggested');
assert.equal(
  deriveTransactionReviewState({
    payload: { ai_suggestion_status: 'applied' }
  }),
  'accepted'
);
assert.equal(
  deriveTransactionReviewState({
    payload: { evidence_request: { status: 'open', sent_at: 1714480000000 } }
  }),
  'waiting'
);
assert.equal(
  deriveTransactionReviewState({
    payload: {},
    patch: { reviewer_note: 'Client evidence request created.' }
  }),
  'waiting'
);
// Canonical PR 3 vocabulary.
assert.equal(deriveTransactionReviewState({ payload: {}, status: 'resolved' }), 'resolved');
assert.equal(deriveTransactionReviewState({ payload: {}, status: 'cancelled' }), 'resolved');
// Legacy values still accepted on read so unmigrated rows / older
// payloads don't surface as 'suggested' in the FE workflow.
assert.equal(deriveTransactionReviewState({ payload: {}, status: 'closed' }), 'resolved');
assert.equal(deriveTransactionReviewState({ payload: {}, status: 'dismissed' }), 'resolved');
assert.equal(deriveTransactionReviewState({ payload: { xero_sync_status: 'synced' } }), 'synced');
assert.equal(
  deriveTransactionReviewState({
    payload: { review_state: 'waiting' },
    patch: { review_state: 'synced' }
  }),
  'synced'
);

console.log('Transaction review state tests passed');
