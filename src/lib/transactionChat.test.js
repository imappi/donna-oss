// transactionChat — FE pure-helper tests.
//
// Pins findNewClientReplies, the diff used by the polling tick to
// decide whether to fire a toast. False positives would spam the
// firm; false negatives would defeat the purpose of the toast.

import assert from 'node:assert/strict';

import {
  describeTransactionAction,
  findNewClientReplies,
  MATCH_REJECTION_CHOICES,
  matchRejectionPrompt,
  transactionChatActionTargetIds,
  TRANSACTION_ACTION_TYPE_LABELS
} from './transactionChat.js';

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

console.log('transactionChat (FE helpers):');

const reply = (id, overrides = {}) => ({
  id,
  role: 'system',
  payload: { kind: 'client_reply_received', evidence_request_id: 'ev-1' },
  content: 'Reply',
  ...overrides
});

await test('findNewClientReplies: brand-new reply in next → returned', () => {
  const prev = [];
  const next = [reply('m1')];
  const out = findNewClientReplies(prev, next);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'm1');
});

await test('findNewClientReplies: reply already in prev → NOT returned (idempotent)', () => {
  // Same server snapshot arriving twice (e.g. firm clicks refresh
  // during a poll). We must not toast the same reply twice.
  const prev = [reply('m1')];
  const next = [reply('m1')];
  assert.equal(findNewClientReplies(prev, next).length, 0);
});

await test('findNewClientReplies: ignores non-system messages and non-client-reply kinds', () => {
  // The toast is specifically for inbound client replies. Donna
  // assistant turns, firm-typed messages, and other system kinds
  // (ask_client_confirmation, apply outcomes) must not fire it.
  const next = [
    reply('m1', { role: 'user', payload: { kind: 'client_reply_received' } }),       // wrong role
    reply('m2', { role: 'system', payload: { kind: 'ask_client_confirmation' } }),   // wrong kind
    reply('m3', { role: 'system', payload: {} }),                                    // no kind
    reply('m4', { role: 'assistant', payload: { kind: 'client_reply_received' } })   // wrong role
  ];
  assert.equal(findNewClientReplies([], next).length, 0);
});

await test('findNewClientReplies: multiple new replies in one poll → all returned', () => {
  // A backfill or a burst of replies could land in a single tick.
  // Caller decides how to coalesce; this helper returns every match.
  const prev = [reply('m1')];
  const next = [reply('m1'), reply('m2'), reply('m3')];
  const out = findNewClientReplies(prev, next);
  assert.deepEqual(out.map((m) => m.id), ['m2', 'm3']);
});

await test('findNewClientReplies: messages without ids are skipped', () => {
  // Defensive — a malformed server row without an id can't be deduped
  // safely (every poll would re-toast it). Skip rather than emit.
  const next = [reply(null), reply(undefined), reply('m1')];
  const out = findNewClientReplies([], next);
  assert.deepEqual(out.map((m) => m.id), ['m1']);
});

await test('findNewClientReplies: defensive on nullish inputs', () => {
  assert.deepEqual(findNewClientReplies(null, null), []);
  assert.deepEqual(findNewClientReplies(undefined, undefined), []);
  assert.deepEqual(findNewClientReplies(null, [reply('m1')]).map((m) => m.id), ['m1']);
  assert.deepEqual(findNewClientReplies([reply('m1')], null), []);
});

await test('reject_match: has a human label (renders "Reject match", not the raw type)', () => {
  assert.equal(TRANSACTION_ACTION_TYPE_LABELS.reject_match, 'Reject match');
});

await test('resolve_match_group: human label and every proposed pair are visible', () => {
  assert.equal(TRANSACTION_ACTION_TYPE_LABELS.resolve_match_group, 'Pair & reconcile group');
  assert.deepEqual(describeTransactionAction({
    type: 'resolve_match_group',
    match_pairs: [
      { transaction_id: 'tx-28', document_id: 'doc-28' },
      { transaction_id: 'tx-29', document_id: 'doc-29' }
    ]
  }), [
    'Pair 1: tx-28 → doc-28',
    'Pair 2: tx-29 → doc-29'
  ]);
});

await test('resolve_match_group: apply lifecycle targets every paired transaction once', () => {
  assert.deepEqual(transactionChatActionTargetIds({
    focusedTransactionId: 'tx-focused',
    action: {
      type: 'resolve_match_group',
      match_pairs: [
        { transaction_id: 'tx-28', document_id: 'doc-28' },
        { transaction_id: 'tx-29', document_id: 'doc-29' },
        { transaction_id: 'tx-28', document_id: 'doc-duplicate' }
      ]
    }
  }), ['tx-28', 'tx-29']);
});

await test('single-row actions target the focused transaction for apply feedback', () => {
  assert.deepEqual(transactionChatActionTargetIds({
    focusedTransactionId: 'tx-focused',
    action: { type: 'apply_category' }
  }), ['tx-focused']);
  assert.deepEqual(transactionChatActionTargetIds({
    focusedTransactionId: 'tx-focused',
    action: { type: 'resolve_match_group', match_pairs: [] }
  }), ['tx-focused']);
});

await test('reject_match: describe surfaces the blast radius (no document_id → just the warning)', () => {
  const lines = describeTransactionAction({ type: 'reject_match', reason: 'wrong doc' });
  assert.deepEqual(lines, ['Rejects the current reconciliation match']);
});

await test('reject_match: describe shows the named document when document_id is set', () => {
  const lines = describeTransactionAction({ type: 'reject_match', document_id: 'doc-9', reason: 'wrong doc' });
  assert.deepEqual(lines, ['Rejects the current reconciliation match', 'Document: doc-9']);
});

await test('guided rejection: exposes the five bounded reasons in the intended order', () => {
  assert.deepEqual(MATCH_REJECTION_CHOICES.map((choice) => choice.label), [
    'Wrong document',
    'Wrong transaction',
    'Already settled elsewhere',
    'These should never be matched',
    'Something else…'
  ]);
});

await test('guided rejection: every fixed choice starts conversation and never claims the match changed', () => {
  for (const choice of MATCH_REJECTION_CHOICES.filter((item) => item.id !== 'other')) {
    const prompt = matchRejectionPrompt(choice.id);
    assert.match(prompt, /Help me/);
    assert.doesNotMatch(prompt, /has been rejected|was rejected|I rejected/);
  }
  assert.match(matchRejectionPrompt('never_match'), /remember the correction/);
  assert.equal(matchRejectionPrompt('other'), null);
  assert.equal(matchRejectionPrompt('unknown'), null);
});

await test('correct_document_field: has a human label (renders "Correct document field", not the raw type)', () => {
  assert.equal(TRANSACTION_ACTION_TYPE_LABELS.correct_document_field, 'Correct document field');
});

await test('correct_document_field: describe surfaces the field and the new value', () => {
  const lines = describeTransactionAction({
    type: 'correct_document_field',
    field_path: 'total_amount',
    corrected_value: '745.00',
    reason: 'amount parsed wrong'
  });
  assert.deepEqual(lines, ['Field: total_amount', 'New value: 745.00']);
});

await test('correct_document_field: describe adds the named document when document_id is set', () => {
  const lines = describeTransactionAction({
    type: 'correct_document_field',
    field_path: 'document_date',
    corrected_value: '2026-04-05',
    document_id: 'doc-9'
  });
  assert.deepEqual(lines, ['Field: document_date', 'New value: 2026-04-05', 'Document: doc-9']);
});

console.log(`\ntransactionChat (FE helpers): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
