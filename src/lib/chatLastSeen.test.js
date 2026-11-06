// chatLastSeen — pure-logic tests.
//
// Pins the unread-id derivation. The localStorage wrappers are thin
// (a typo there is caught visually, no recoverable invariant to
// test); the gating logic in computeUnreadTransactionIds is where
// off-by-one and timestamp-coercion bugs would hide.

import assert from 'node:assert/strict';

import { computeUnreadTransactionIds } from './chatLastSeen.js';

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

console.log('chatLastSeen:');

await test('computeUnreadTransactionIds: empty summary → empty set', () => {
  assert.equal(computeUnreadTransactionIds([], {}).size, 0);
});

await test('computeUnreadTransactionIds: no last-seen entry → unread', () => {
  // Never opened. Any server reply badges it.
  const summary = [
    { transaction_id: 'tx-1', latest_client_reply_at: '2024-04-01T10:00:00Z' }
  ];
  const unread = computeUnreadTransactionIds(summary, {});
  assert.deepEqual([...unread], ['tx-1']);
});

await test('computeUnreadTransactionIds: last-seen newer than reply → not unread', () => {
  // Opened the chat after the reply landed — firm has seen it.
  const summary = [
    { transaction_id: 'tx-1', latest_client_reply_at: '2024-04-01T10:00:00Z' }
  ];
  const unread = computeUnreadTransactionIds(summary, {
    'tx-1': '2024-04-01T11:00:00Z'
  });
  assert.equal(unread.size, 0);
});

await test('computeUnreadTransactionIds: last-seen equals reply → not unread (inclusive)', () => {
  // Equal-timestamp guard: the firm opened the artifact at the same
  // instant the reply landed — they saw it (the polling tick merges
  // it into the open chat). Don't re-badge.
  const summary = [
    { transaction_id: 'tx-1', latest_client_reply_at: '2024-04-01T10:00:00Z' }
  ];
  const unread = computeUnreadTransactionIds(summary, {
    'tx-1': '2024-04-01T10:00:00Z'
  });
  assert.equal(unread.size, 0);
});

await test('computeUnreadTransactionIds: last-seen older than reply → unread', () => {
  // Reply arrived after the firm last looked.
  const summary = [
    { transaction_id: 'tx-1', latest_client_reply_at: '2024-04-01T10:00:00Z' }
  ];
  const unread = computeUnreadTransactionIds(summary, {
    'tx-1': '2024-03-30T10:00:00Z'
  });
  assert.deepEqual([...unread], ['tx-1']);
});

await test('computeUnreadTransactionIds: filters out entries with null reply timestamp', () => {
  // Should never happen via the route (we exclude transactions with
  // no replies in the SQL group-by), but the FE shouldn't trust it.
  const summary = [
    { transaction_id: 'tx-1', latest_client_reply_at: null },
    { transaction_id: 'tx-2', latest_client_reply_at: '2024-04-01T10:00:00Z' }
  ];
  const unread = computeUnreadTransactionIds(summary, {});
  assert.deepEqual([...unread], ['tx-2']);
});

await test('computeUnreadTransactionIds: malformed last-seen falls back to "never seen"', () => {
  // Corrupted localStorage entry must not silently mark seen — we
  // err toward "show the badge" so the firm at least gets a hint.
  const summary = [
    { transaction_id: 'tx-1', latest_client_reply_at: '2024-04-01T10:00:00Z' }
  ];
  const unread = computeUnreadTransactionIds(summary, { 'tx-1': 'not-a-date' });
  assert.deepEqual([...unread], ['tx-1']);
});

await test('computeUnreadTransactionIds: multiple transactions, mixed states', () => {
  const summary = [
    { transaction_id: 'tx-a', latest_client_reply_at: '2024-04-01T10:00:00Z' }, // unread, never seen
    { transaction_id: 'tx-b', latest_client_reply_at: '2024-04-01T10:00:00Z' }, // seen later → no badge
    { transaction_id: 'tx-c', latest_client_reply_at: '2024-04-01T10:00:00Z' }  // seen before → unread
  ];
  const unread = computeUnreadTransactionIds(summary, {
    'tx-b': '2024-04-01T11:00:00Z',
    'tx-c': '2024-03-15T08:00:00Z'
  });
  assert.deepEqual([...unread].sort(), ['tx-a', 'tx-c']);
});

await test('computeUnreadTransactionIds: defensive on nullish inputs', () => {
  assert.equal(computeUnreadTransactionIds(null, null).size, 0);
  assert.equal(computeUnreadTransactionIds(undefined, undefined).size, 0);
});

console.log(`\nchatLastSeen: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
