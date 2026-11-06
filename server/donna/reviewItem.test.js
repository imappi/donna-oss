import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REVIEW_ITEM_STATUSES,
  REVIEW_ITEM_TYPES,
  assertValidReviewItemStatus,
  emitReviewAudit,
  normalizeReviewItemStatus,
  rowToReviewItemPayload
} from './reviewItem.js';

// ── Status normalisation ───────────────────────────────────────────────

await test('normalizeReviewItemStatus: canonical values pass through', () => {
  for (const status of REVIEW_ITEM_STATUSES) {
    assert.equal(normalizeReviewItemStatus(status), status);
  }
});

await test('normalizeReviewItemStatus: legacy aliases map to canonical form', () => {
  assert.equal(normalizeReviewItemStatus('closed'), 'resolved');
  assert.equal(normalizeReviewItemStatus('dismissed'), 'cancelled');
});

await test('normalizeReviewItemStatus: trims + lowercases', () => {
  assert.equal(normalizeReviewItemStatus('  OPEN '), 'open');
  assert.equal(normalizeReviewItemStatus('Resolved'), 'resolved');
});

await test('normalizeReviewItemStatus: unknown values return null', () => {
  assert.equal(normalizeReviewItemStatus('nope'), null);
  assert.equal(normalizeReviewItemStatus(null), null);
  assert.equal(normalizeReviewItemStatus(''), null);
});

await test('assertValidReviewItemStatus: throws 400 on unknown', () => {
  assert.throws(
    () => assertValidReviewItemStatus('nope'),
    (err) => err.statusCode === 400 && err.code === 'INVALID_REVIEW_ITEM_STATUS'
  );
});

await test('assertValidReviewItemStatus: accepts and returns canonical', () => {
  assert.equal(assertValidReviewItemStatus('open'), 'open');
  assert.equal(assertValidReviewItemStatus('closed'), 'resolved');
});

// ── DTO ────────────────────────────────────────────────────────────────

await test('rowToReviewItemPayload: transaction item maps to shared envelope', () => {
  const dto = rowToReviewItemPayload({
    id: 'rvq-1',
    firm_id: 'firm-1',
    client_id: 'client-1',
    item_type: 'transaction',
    item_id: 'tx-1',
    reason: 'ambiguous_match',
    priority: 'normal',
    status: 'open',
    payload: { transaction_id: 'tx-1' },
    review_state: 'suggested',
    created_at: new Date('2026-04-01T00:00:00Z'),
    updated_at: new Date('2026-04-02T00:00:00Z')
  });
  assert.equal(dto.item_type, 'transaction');
  assert.equal(dto.status, 'open');
  assert.equal(dto.review_state, 'suggested');
  assert.equal(dto.created_at, '2026-04-01T00:00:00.000Z');
});

await test('rowToReviewItemPayload: document_line item carries the same envelope keys', () => {
  const dto = rowToReviewItemPayload({
    id: 'rvq-2',
    firm_id: 'firm-1',
    client_id: 'client-1',
    item_type: 'document_line',
    item_id: 'doc-1-ln-1',
    reason: 'amount_mismatch',
    priority: 'normal',
    status: 'open',
    payload: {},
    created_at: new Date('2026-04-03T00:00:00Z')
  });
  assert.equal(dto.item_type, 'document_line');
  assert.equal(dto.item_id, 'doc-1-ln-1');
  assert.equal(dto.reason, 'amount_mismatch');
  // Envelope keys must match the transaction shape exactly so consumers
  // can branch without re-reading two shapes.
  for (const key of [
    'id', 'firm_id', 'client_id', 'item_type', 'item_id', 'reason',
    'priority', 'status', 'assigned_to', 'payload', 'review_state',
    'created_at', 'updated_at'
  ]) {
    assert.ok(key in dto, `missing key ${key}`);
  }
});

await test('rowToReviewItemPayload: legacy "closed" status reads as "resolved"', () => {
  const dto = rowToReviewItemPayload({
    id: 'rvq-3',
    item_type: 'transaction',
    item_id: 'tx-1',
    status: 'closed'
  });
  assert.equal(dto.status, 'resolved');
});

await test('rowToReviewItemPayload: missing item_type defaults to "transaction"', () => {
  const dto = rowToReviewItemPayload({ id: 'rvq-4', item_id: 'tx-1', status: 'open' });
  assert.equal(dto.item_type, 'transaction');
});

await test('REVIEW_ITEM_TYPES contract', () => {
  assert.ok(REVIEW_ITEM_TYPES.includes('transaction'));
  assert.ok(REVIEW_ITEM_TYPES.includes('reconciliation_match'));
  assert.ok(REVIEW_ITEM_TYPES.includes('document_line'));
});

// ── Audit shim ─────────────────────────────────────────────────────────

const makeAuditClient = () => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
  };
};

await test('emitReviewAudit: writes a single event when no legacyAction provided', async () => {
  const client = makeAuditClient();
  await emitReviewAudit(client, {
    firmId: 'firm-1',
    clientId: 'client-1',
    itemType: 'document_line',
    itemId: 'doc-1-ln-1',
    action: 'review.accepted',
    actorId: 'kari@books.example',
    metadata: { had_amount_mismatch: false }
  });
  assert.equal(client.calls.length, 1);
  const [call] = client.calls;
  // actor_id added at param index 2 (pod-safety gap #1) shifts the rest +1.
  assert.equal(call.params[2], 'kari@books.example');
  assert.equal(call.params[3], 'review.accepted');
  assert.equal(call.params[4], 'document_line');
  assert.equal(call.params[5], 'doc-1-ln-1');
  const meta = JSON.parse(call.params[6]);
  assert.equal(meta.item_type, 'document_line');
  assert.equal(meta.item_id, 'doc-1-ln-1');
  assert.equal(meta.had_amount_mismatch, false);
});

await test('emitReviewAudit: actor_id defaults to system when no operator passed', async () => {
  const client = makeAuditClient();
  await emitReviewAudit(client, {
    firmId: 'firm-1',
    clientId: 'client-1',
    itemType: 'transaction',
    itemId: 'tx-1',
    action: 'review.accepted'
  });
  assert.equal(client.calls[0].params[2], 'system');
});

await test('emitReviewAudit: dual-emits when legacyAction is set', async () => {
  const client = makeAuditClient();
  await emitReviewAudit(client, {
    firmId: 'firm-1',
    clientId: 'client-1',
    itemType: 'transaction',
    itemId: 'tx-1',
    action: 'review.accepted',
    legacyAction: 'transaction_review.update',
    legacyResourceType: 'transaction_review',
    metadata: { source: 'firm_patch' }
  });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].params[3], 'review.accepted');
  assert.equal(client.calls[1].params[3], 'transaction_review.update');
  // Same item_type / item_id metadata on both rows.
  const m0 = JSON.parse(client.calls[0].params[6]);
  const m1 = JSON.parse(client.calls[1].params[6]);
  assert.equal(m0.item_type, m1.item_type);
  assert.equal(m0.item_id, m1.item_id);
});

await test('emitReviewAudit: skips silently when client/firm/action are missing', async () => {
  const client = makeAuditClient();
  await emitReviewAudit(null, { firmId: 'firm-1', action: 'review.accepted' });
  await emitReviewAudit(client, { firmId: null, action: 'review.accepted' });
  await emitReviewAudit(client, { firmId: 'firm-1', action: '' });
  assert.equal(client.calls.length, 0);
});

console.log('reviewItem tests passed');
