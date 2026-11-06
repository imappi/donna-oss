import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFirmFeed } from '../../../server/donna/firmFeed.js';
import {
  entityOwnerCounts,
  isPeriodOwnedDecision,
  periodOwnedDecisionItems,
  presentFeedBuckets,
  projectEntityOwnerInventory
} from './entity-owner-inventory.js';

const buckets = (overrides = {}) => ({
  auto_cleared: [],
  confirmable: [],
  operator_blocker: [],
  client_info_needed: [],
  ...overrides
});

const item = (kind, sourceId, overrides = {}) => ({
  kind,
  source_id: sourceId,
  client_id: 'client-a',
  verdict: { disposition: 'operator_blocker', blocks_close: true },
  ...overrides
});

test('characterizes existing owner counts and makes counts a lossless inventory reduction', () => {
  const feed = { buckets: buckets({
    operator_blocker: [
      item('failed_parse', 'doc-failed'),
      item('ask_batch_draft', 'batch-1'),
      item('review_item', 'review-working', { verdict: { disposition: 'operator_blocker' } })
    ],
    confirmable: [item('reconciliation_match', 'match-confirm', { verdict: { disposition: 'confirmable' } })],
    client_info_needed: [item('client_evidence_request', 'ask-open', { verdict: { disposition: 'client_info_needed' } })],
    auto_cleared: [item('reconciliation_match', 'match-done', { verdict: { disposition: 'auto_cleared' } })]
  }) };

  const inventory = projectEntityOwnerInventory(feed);
  assert.deepEqual(entityOwnerCounts(feed), { for_you: 2, waiting: 1, donna: 2, done: 1 });
  assert.deepEqual(
    Object.fromEntries(['for_you', 'waiting', 'donna', 'done'].map((state) => [
      state, inventory.filter((entry) => entry.owner_state === state).length
    ])),
    entityOwnerCounts(feed)
  );
});

test('confirmable lines stay lossless but present under Donna instead of a human confirmation lane', () => {
  const confirmable = item('reconciliation_match', 'match-confirm', {
    verdict: { disposition: 'confirmable', blocks_close: false }
  });
  const donnaWork = item('review_item', 'review-working', {
    verdict: { disposition: 'operator_blocker', blocks_close: false }
  });
  const userDecision = item('failed_parse', 'doc-failed');
  const presented = presentFeedBuckets(buckets({
    confirmable: [confirmable],
    operator_blocker: [donnaWork, userDecision]
  }));

  assert.equal(presented.confirmable, undefined);
  assert.deepEqual(presented.operator_blocker.map((entry) => entry.source_id), ['doc-failed']);
  assert.deepEqual(presented.donna_working.map((entry) => entry.source_id), ['match-confirm', 'review-working']);
});

test('dated accounting decisions belong to their period while a multi-line draft remains venture-wide', () => {
  const taxDecision = item('reconciliation_match', 'match-tax', {
    transaction_id: 'tx-tax',
    transaction_date: '2025-08-27',
    verdict: { disposition: 'operator_blocker', risk_class: 'tax_sensitive', blocks_close: true }
  });
  const failedParse = item('failed_parse', 'doc-failed', {
    document_id: 'doc-failed',
    transaction_date: '2025-07-02'
  });
  const draft = item('ask_batch_draft', 'batch-1', {
    covered_transaction_ids: ['tx-other'],
    transaction_date: '2025-08-28'
  });
  const otherClient = item('failed_parse', 'doc-other', {
    client_id: 'client-b',
    document_id: 'doc-other',
    transaction_date: '2025-06-01'
  });
  const feed = { buckets: buckets({ operator_blocker: [taxDecision, failedParse, draft, otherClient] }) };

  assert.equal(isPeriodOwnedDecision(taxDecision), true);
  assert.equal(isPeriodOwnedDecision(failedParse), true);
  assert.equal(isPeriodOwnedDecision(draft), false);
  assert.deepEqual(
    periodOwnedDecisionItems(feed, 'client-a').map((entry) => entry.source_id),
    ['match-tax', 'doc-failed']
  );
});

test('retains source identity and production classification for every supported population', () => {
  const feed = { buckets: buckets({
    operator_blocker: [
      item('failed_parse', 'doc-1'),
      item('review_item', 'review-1', { document_id: 'doc-2' }),
      item('ask_batch_draft', 'batch-1')
    ],
    confirmable: [item('reconciliation_match', 'match-1', {
      transaction_id: 'tx-1',
      verdict: { disposition: 'confirmable', risk_class: 'routine', blocks_close: false }
    })],
    client_info_needed: [item('client_evidence_request', 'ask-1', {
      transaction_id: 'tx-2', verdict: { disposition: 'client_info_needed' }
    })]
  }) };
  const inventory = projectEntityOwnerInventory(feed);
  assert.deepEqual(new Set(inventory.map((entry) => entry.source_kind)), new Set([
    'failed_parse', 'review_item', 'ask_batch_draft', 'reconciliation_match', 'client_evidence_request'
  ]));
  assert.equal(inventory.find((entry) => entry.source_id === 'match-1').canonical_identity, 'reconciliation_match:match-1');
  assert.deepEqual(inventory.find((entry) => entry.source_id === 'match-1').classification, {
    disposition: 'confirmable', risk_class: 'routine', blocks_close: false, presentation_decidable: false
  });
});

test('draft transaction anchors deduplicate the covered presentation row', () => {
  const feed = { buckets: buckets({ operator_blocker: [
    item('ask_batch_draft', 'batch-1', { covered_transaction_ids: ['tx-1'] }),
    item('review_item', 'review-1', { transaction_id: 'tx-1' }),
    item('review_item', 'review-2', { transaction_id: 'tx-2' })
  ] }) };
  assert.deepEqual(projectEntityOwnerInventory(feed).map((entry) => entry.source_id), ['batch-1', 'review-2']);
  assert.deepEqual(entityOwnerCounts(feed), { for_you: 1, waiting: 0, donna: 1, done: 0 });
});

test('buildFirmFeed open asks win over duplicate review rows while replied processing asks retain current omission', () => {
  const baseRequest = {
    firm_id: 'firm-1', client_id: 'client-a', transaction_id: 'tx-1',
    evidence_type: 'receipt', question: 'What was this?', request_payload: {},
    first_sent_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z'
  };
  const feed = buildFirmFeed({
    firm: { id: 'firm-1', jurisdiction: 'SG' },
    clients: [{ id: 'client-a', company_name: 'A' }],
    transactions: [{ id: 'tx-1', client_id: 'client-a', description: 'Line', money_out: 10 }],
    transactionReviewQueue: [{
      id: 'review-1', client_id: 'client-a', item_type: 'transaction', item_id: 'tx-1',
      reason: 'category_needs_review', review_state: 'asked_client', status: 'open',
      payload: { evidence_request: { status: 'open', evidence_type: 'receipt' } }
    }],
    clientEvidenceRequests: [
      { ...baseRequest, id: 'ask-open', status: 'open' },
      { ...baseRequest, id: 'ask-processing', transaction_id: 'tx-2', status: 'replied' }
    ]
  });
  const inventory = projectEntityOwnerInventory(feed);
  assert.deepEqual(inventory.map((entry) => entry.canonical_identity), ['client_evidence_request:ask-open']);
  assert.equal(inventory[0].owner_state, 'waiting');
});

test('missing and duplicate canonical identities fail closed', () => {
  assert.throws(
    () => projectEntityOwnerInventory({ buckets: buckets({ confirmable: [
      item('reconciliation_match', '', { verdict: { disposition: 'confirmable' } })
    ] }) }),
    /lacks a usable source identity/
  );
  const duplicate = item('review_item', 'same');
  assert.throws(
    () => projectEntityOwnerInventory({ buckets: buckets({ operator_blocker: [duplicate, duplicate] }) }),
    /duplicate canonical identity review_item:same/
  );
});

test('unknown bucket and source classifications fail rather than appearing settled', () => {
  assert.throws(
    () => projectEntityOwnerInventory({ buckets: buckets({ mystery_settled: [] }) }),
    /unrecognised feed bucket mystery_settled/
  );
  assert.throws(
    () => projectEntityOwnerInventory({ buckets: buckets({ auto_cleared: [item('new_unknown_kind', 'x')] }) }),
    /ambiguous owner classification/
  );
  assert.throws(
    () => projectEntityOwnerInventory({ buckets: buckets({ auto_cleared: [
      item('new_unknown_kind', 'x', { verdict: { disposition: 'auto_cleared' } })
    ] }) }),
    /unrecognised source kind new_unknown_kind/
  );
});

test('equal aggregate totals cannot conceal compensated identity drift', () => {
  const left = { buckets: buckets({ confirmable: [
    item('reconciliation_match', 'match-a', { verdict: { disposition: 'confirmable' } })
  ] }) };
  const right = { buckets: buckets({ confirmable: [
    item('reconciliation_match', 'match-b', { verdict: { disposition: 'confirmable' } })
  ] }) };
  assert.deepEqual(entityOwnerCounts(left), entityOwnerCounts(right));
  assert.notDeepEqual(
    projectEntityOwnerInventory(left).map((entry) => entry.canonical_identity),
    projectEntityOwnerInventory(right).map((entry) => entry.canonical_identity)
  );
});

test('client filtering preserves entity-scoped UI count semantics', () => {
  const feed = { buckets: buckets({ confirmable: [
    item('reconciliation_match', 'a', { verdict: { disposition: 'confirmable' } }),
    item('reconciliation_match', 'b', { client_id: 'client-b', verdict: { disposition: 'confirmable' } })
  ] }) };
  assert.deepEqual(entityOwnerCounts(feed, 'client-a'), { for_you: 0, waiting: 0, donna: 1, done: 0 });
  assert.deepEqual(projectEntityOwnerInventory(feed, 'client-a').map((entry) => entry.source_id), ['a']);
});
