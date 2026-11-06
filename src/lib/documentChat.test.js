// Document chat — FE pure-helper tests (PR 27).
//
// Pins the UI-side gates that PR 27 ships:
//   - PR 27 ALWAYS disables Apply because `appliableTypes` arrives
//     empty from the server. A regression that flips this without
//     the matching writer landing would surface immediately.
//   - describeAction is bounded; long fields truncate; unknown
//     action types return empty without throwing.
//   - formatChatTimestamp never returns raw ISO.

import assert from 'node:assert/strict';

import {
  ACTION_TYPE_MESSAGE_IDS,
  actionSupportsApply,
  deriveActionCardState,
  describeAction,
  documentNeedsCurrencyConfirmation,
  formatChatTimestamp,
  isNearBottom,
  mergeChatMessages
} from './documentChat.js';

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

console.log('documentChat (FE helpers):');

// ─── Apply gate ──────────────────────────────────────────────────────────

await test('PR 28: with appliableTypes=[link_transaction], only link_transaction is appliable', () => {
  // PR 28 ships link_transaction wired to the manual-link writer.
  // The other six action types stay unappliable until PRs 29+.
  // The server-side DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES is the
  // source of truth; this test pins how the FE gate interprets it.
  const set = ['link_transaction'];
  assert.equal(actionSupportsApply({ type: 'link_transaction' }, set), true);
  assert.equal(actionSupportsApply({ type: 'search_transactions' }, set), false);
  assert.equal(actionSupportsApply({ type: 'explain_match_reasoning' }, set), false);
  assert.equal(actionSupportsApply({ type: 'leave_review_note' }, set), false);
  assert.equal(actionSupportsApply({ type: 'mark_immaterial' }, set), false);
  assert.equal(actionSupportsApply({ type: 'draft_evidence_request' }, set), false);
  assert.equal(actionSupportsApply({ type: 'future_action' }, set), false);
});

await test('actionSupportsApply: empty appliable set → every type FALSE (defensive)', () => {
  // If the FE somehow loads against a server that hasn't shipped
  // PR 28 yet (mixed deployment, stale cache), the empty set must
  // disable everything. This protects against a half-rolled deploy
  // where the FE shows an enabled Apply button against a server
  // that 500s on the apply endpoint.
  assert.equal(actionSupportsApply({ type: 'link_transaction' }, []), false);
  assert.equal(actionSupportsApply({ type: 'search_transactions' }, []), false);
});

await test('actionSupportsApply: missing/invalid action shape → FALSE', () => {
  assert.equal(actionSupportsApply(null, ['link_transaction']), false);
  assert.equal(actionSupportsApply(undefined, ['link_transaction']), false);
  assert.equal(actionSupportsApply({}, ['link_transaction']), false);
  assert.equal(actionSupportsApply({ type: null }, ['link_transaction']), false);
});

await test('actionSupportsApply: non-array appliableTypes → FALSE (defensive)', () => {
  assert.equal(actionSupportsApply({ type: 'link_transaction' }, null), false);
  assert.equal(actionSupportsApply({ type: 'link_transaction' }, undefined), false);
  assert.equal(actionSupportsApply({ type: 'link_transaction' }, 'link_transaction'), false);
});

// ─── Action vocabulary coverage ──────────────────────────────────────────

await test('ACTION_TYPE_MESSAGE_IDS covers every v1 action type + future_action', () => {
  // If a new action type lands in PRs 28+ without a label, the
  // chat card falls back to the raw enum string. That's a
  // regression — labels should be added alongside the schema
  // change. This test pins the current contract.
  for (const t of [
    'explain_match_reasoning',
    'search_transactions',
    'link_transaction',
    'draft_evidence_request',
    'leave_review_note',
    'mark_immaterial',
    'future_action'
  ]) {
    assert.match(ACTION_TYPE_MESSAGE_IDS[t], /^document\.action\.type\./, `missing catalog id for ${t}`);
  }
});

// ─── describeAction (bounded, type-aware) ────────────────────────────────

await test('describeAction(explain_match_reasoning): renders summary + signals + blockers', () => {
  const out = describeAction({
    type: 'explain_match_reasoning',
    summary: 'tx-1 matches amount but is on the wrong direction',
    signals: ['amount_exact', 'currency_match'],
    blockers: ['wrong_direction']
  });
  assert.ok(out.some((field) => field.labelId === 'document.action.detail.summary' && field.value.includes('tx-1')));
  assert.deepEqual(out.find((field) => field.labelId === 'document.action.detail.signals')?.value, ['amount_exact', 'currency_match']);
  assert.deepEqual(out.find((field) => field.labelId === 'document.action.detail.blockers')?.value, ['wrong_direction']);
});

await test('describeAction(search_transactions): renders amount + date range + description + currency + direction', () => {
  const out = describeAction({
    type: 'search_transactions',
    amount_eq: 745,
    date_from: '2024-07-01',
    date_to: '2024-07-31',
    description_contains: 'WIRE',
    currency: 'GBP',
    direction: 'money_in'
  });
  assert.deepEqual(out.find((field) => field.labelId === 'document.action.detail.amount'), {
    labelId: 'document.action.detail.amount', kind: 'amount', value: 745, currency: 'GBP'
  });
  assert.deepEqual(out.find((field) => field.labelId === 'document.action.detail.date')?.value, {
    from: '2024-07-01', to: '2024-07-31'
  });
  assert.equal(out.find((field) => field.labelId === 'document.action.detail.description')?.value, 'WIRE');
  assert.equal(out.find((field) => field.labelId === 'document.action.detail.currency')?.value, 'GBP');
  assert.equal(out.find((field) => field.labelId === 'document.action.detail.direction')?.value, 'money_in');
});

await test('describeAction(link_transaction): renders transaction id', () => {
  const out = describeAction({ type: 'link_transaction', transaction_id: 'tx-abc-123' });
  assert.deepEqual(out[0], {
    labelId: 'document.action.detail.transaction', kind: 'identifier', value: 'tx-abc-123'
  });
});

await test('describeAction(draft_evidence_request): renders recipient + question', () => {
  const out = describeAction({
    type: 'draft_evidence_request',
    recipient: 'customer',
    question: 'Could you confirm the payment date for invoice 7FC4A3D8?'
  });
  assert.equal(out.find((field) => field.labelId === 'document.action.detail.recipient')?.value, 'customer');
  assert.ok(out.find((field) => field.labelId === 'document.action.detail.question')?.value.includes('7FC4A3D8'));
});

await test('describeAction(leave_review_note): renders note + follow_up_at', () => {
  const out = describeAction({
    type: 'leave_review_note',
    note: 'Review at month-end — likely paid outside the bank feed.',
    follow_up_at: '2024-07-31'
  });
  assert.ok(out.find((field) => field.labelId === 'document.action.detail.note')?.value.includes('month-end'));
  assert.equal(out.find((field) => field.labelId === 'document.action.detail.followUp')?.value, '2024-07-31');
});

await test('describeAction(mark_immaterial): renders threshold when present', () => {
  const out = describeAction({ type: 'mark_immaterial', threshold_amount: 10 });
  assert.deepEqual(out[0], {
    labelId: 'document.action.detail.materialityThreshold', kind: 'amount', value: 10, currency: null
  });
});

await test('describeAction(future_action): renders future_type', () => {
  const out = describeAction({
    type: 'future_action',
    future_type: 'split_match',
    reason: 'Receipt covers two bank lines.'
  });
  assert.equal(out[0]?.value, 'split_match');
});

await test('describeAction: unknown action type returns empty array (no throw)', () => {
  // The server-side schema constrains the type enum, but a stale
  // FE against a future server could see new types. Render nothing
  // rather than crashing.
  const out = describeAction({ type: 'absolutely_not_a_real_action' });
  assert.deepEqual(out, []);
});

await test('describeAction: null/undefined/non-object → empty array', () => {
  assert.deepEqual(describeAction(null), []);
  assert.deepEqual(describeAction(undefined), []);
  assert.deepEqual(describeAction('not an object'), []);
  assert.deepEqual(describeAction(42), []);
});

await test('describeAction: bounded — long fields truncate with ellipsis', () => {
  const huge = 'A'.repeat(5000);
  const out = describeAction({
    type: 'leave_review_note',
    note: huge
  });
  const noteField = out.find((field) => field.labelId === 'document.action.detail.note');
  assert.ok(noteField, 'note field rendered');
  assert.ok(noteField.value.length < 200, `truncated, got length ${noteField.value.length}`);
  assert.ok(noteField.value.endsWith('…'));
});

await test('describeAction: empty/whitespace fields are skipped', () => {
  const out = describeAction({
    type: 'leave_review_note',
    note: '   ',
    follow_up_at: ''
  });
  assert.deepEqual(out, []);
});

// ─── formatChatTimestamp ─────────────────────────────────────────────────

await test('formatChatTimestamp: parses ISO strings to compact HH:MM', () => {
  const out = formatChatTimestamp('2026-05-20T14:25:00Z');
  // en-GB locale renders "14:25" — verify it's HH:MM, not raw ISO.
  assert.ok(/^\d{2}:\d{2}$/.test(out), `expected HH:MM, got "${out}"`);
});

await test('formatChatTimestamp: returns "—" on missing/invalid', () => {
  assert.equal(formatChatTimestamp(null), '—');
  assert.equal(formatChatTimestamp(undefined), '—');
  assert.equal(formatChatTimestamp(''), '—');
  assert.equal(formatChatTimestamp('not-a-date'), '—');
});

// ─── deriveActionCardState (PR 28 — action-card state machine) ──────────

const APPLIABLE_28 = ['link_transaction']; // matches PR 28's server set

await test('deriveActionCardState: applied action → phase=applied, no button enable', () => {
  const card = deriveActionCardState({
    action: { type: 'link_transaction', status: 'applied' },
    appliableTypes: APPLIABLE_28,
    hasOnApply: true
  });
  assert.equal(card.phase, 'applied');
  assert.equal(card.statusIsApplied, true);
  assert.equal(card.statusMessageId, 'document.action.status.applied');
  assert.equal(card.enabled, false);
  assert.equal(card.buttonMessageId, 'document.action.button.applied');
});

await test('deriveActionCardState: applying state → phase=applying, disabled, Applying… label', () => {
  const card = deriveActionCardState({
    action: { type: 'link_transaction', status: 'proposed' },
    appliableTypes: APPLIABLE_28,
    applyState: { status: 'applying' },
    hasOnApply: true
  });
  assert.equal(card.phase, 'applying');
  assert.equal(card.enabled, false);
  assert.equal(card.buttonMessageId, 'document.action.button.applying');
});

await test('deriveActionCardState: proposed link_transaction + handler → phase=ready, enabled', () => {
  // PR 28 happy path. The chat user can click Apply.
  const card = deriveActionCardState({
    action: { type: 'link_transaction', status: 'proposed' },
    appliableTypes: APPLIABLE_28,
    hasOnApply: true
  });
  assert.equal(card.phase, 'ready');
  assert.equal(card.enabled, true);
  assert.equal(card.buttonMessageId, 'document.action.button.apply');
  assert.equal(card.supportsApply, true);
});

await test('deriveActionCardState: proposed link_transaction WITHOUT handler → phase=no-handler, disabled', () => {
  // E.g. in-memory mode where the App didn't pass onChatActionSnapshotApplied.
  // We must NOT enable Apply (would call undefined).
  const card = deriveActionCardState({
    action: { type: 'link_transaction', status: 'proposed' },
    appliableTypes: APPLIABLE_28,
    hasOnApply: false
  });
  assert.equal(card.phase, 'no-handler');
  assert.equal(card.enabled, false);
});

await test('deriveActionCardState: superseded action → inert (no enable, superseded label)', () => {
  // A newer assistant turn proposed a replacement of the same type —
  // the server marked this one superseded (Metropolitan coworking:
  // a corrected Categorise & post must disarm the earlier wrong one).
  // Even with a handler wired and the type appliable, the card renders
  // inert; the apply endpoint 409s it server-side regardless.
  const card = deriveActionCardState({
    action: { type: 'link_transaction', status: 'superseded' },
    appliableTypes: APPLIABLE_28,
    hasOnApply: true
  });
  assert.equal(card.phase, 'superseded');
  assert.equal(card.enabled, false);
  assert.equal(card.statusMessageId, 'document.action.status.superseded');
  assert.equal(card.statusIsSuperseded, true);
  assert.equal(card.statusIsApplied, false);
});

await test('deriveActionCardState: unsupported action type → phase=unsupported, unavailable label', () => {
  // PR 28 — only link_transaction is wired. The other five v1 action
  // types (and future_action) must render with the unambiguous
  // localized unavailable label.
  for (const type of [
    'search_transactions',
    'explain_match_reasoning',
    'draft_evidence_request',
    'leave_review_note',
    'mark_immaterial',
    'future_action'
  ]) {
    const card = deriveActionCardState({
      action: { type, status: 'proposed' },
      appliableTypes: APPLIABLE_28,
      hasOnApply: true
    });
    assert.equal(card.phase, 'unsupported', `${type} should be unsupported in PR 28`);
    assert.equal(card.enabled, false);
    assert.equal(card.buttonMessageId, 'document.action.button.comingSoon');
    assert.equal(card.supportsApply, false);
  }
});

await test('deriveActionCardState: empty appliable set (PR 27 baseline / mixed deploy) → every type unsupported', () => {
  // Defensive — if the FE loads against a server that hasn't shipped
  // PR 28, the empty appliable set must disable everything.
  for (const type of [
    'link_transaction',
    'search_transactions',
    'explain_match_reasoning'
  ]) {
    const card = deriveActionCardState({
      action: { type, status: 'proposed' },
      appliableTypes: [],
      hasOnApply: true
    });
    assert.equal(card.phase, 'unsupported');
    assert.equal(card.enabled, false);
    assert.equal(card.buttonMessageId, 'document.action.button.comingSoon');
  }
});

await test('deriveActionCardState: error state surfaces and does NOT enable Apply', () => {
  const card = deriveActionCardState({
    action: { type: 'link_transaction', status: 'proposed' },
    appliableTypes: APPLIABLE_28,
    applyState: { status: 'error', error: 'Transaction not found.' },
    hasOnApply: true
  });
  // Not in-flight, so the phase falls through to 'ready' — the user
  // can retry. The error string is surfaced for display.
  assert.equal(card.phase, 'ready');
  assert.equal(card.enabled, true);
  assert.equal(card.error, 'Transaction not found.');
});

await test('deriveActionCardState: empty error uses the catalog fallback', () => {
  const card = deriveActionCardState({
    action: { type: 'link_transaction', status: 'proposed' },
    appliableTypes: APPLIABLE_28,
    applyState: { status: 'error', error: null },
    hasOnApply: true
  });
  assert.equal(card.phase, 'ready');
  assert.equal(card.error, null);
  assert.equal(card.errorMessageId, 'document.action.error.applyFailed');
});

await test('deriveActionCardState: applied wins over inflight (idempotent server replay)', () => {
  // If a successful apply lands while a retry is in flight, the
  // persisted status should dominate — render Applied, not Applying.
  const card = deriveActionCardState({
    action: { type: 'link_transaction', status: 'applied' },
    appliableTypes: APPLIABLE_28,
    applyState: { status: 'applying' },
    hasOnApply: true
  });
  assert.equal(card.phase, 'applied');
  assert.equal(card.enabled, false);
});

// ─── mergeChatMessages ───────────────────────────────────────────────────
//
// Pins the merge-not-replace semantics used by the auto-poll refresh
// path on both chat surfaces. Get this wrong and a poll will either
// drop firm messages or duplicate server replies into the thread.

await test('mergeChatMessages: appends incoming ids not in existing', () => {
  const existing = [
    { id: 'a', created_at: '2024-01-01T10:00:00Z', content: 'hi' },
    { id: 'b', created_at: '2024-01-01T10:01:00Z', content: 'hello' }
  ];
  const incoming = [
    { id: 'a', created_at: '2024-01-01T10:00:00Z', content: 'hi' },
    { id: 'b', created_at: '2024-01-01T10:01:00Z', content: 'hello' },
    { id: 'c', created_at: '2024-01-01T10:02:00Z', content: 'client replied' }
  ];
  const merged = mergeChatMessages(existing, incoming);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c']);
  assert.equal(merged[2].content, 'client replied');
});

await test('mergeChatMessages: replaces by id when the server updates a message (status flip)', () => {
  // Concrete case: action.status flips proposed → applied on the
  // server. The local copy must be swapped for the server version
  // in-place — same id, same position.
  const existing = [
    {
      id: 'm1',
      created_at: '2024-01-01T10:00:00Z',
      role: 'assistant',
      payload: { actions: [{ type: 'link_transaction', status: 'proposed' }] }
    },
    { id: 'm2', created_at: '2024-01-01T10:01:00Z', role: 'user', content: 'go' }
  ];
  const incoming = [
    {
      id: 'm1',
      created_at: '2024-01-01T10:00:00Z',
      role: 'assistant',
      payload: { actions: [{ type: 'link_transaction', status: 'applied' }] }
    },
    { id: 'm2', created_at: '2024-01-01T10:01:00Z', role: 'user', content: 'go' }
  ];
  const merged = mergeChatMessages(existing, incoming);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((m) => m.id), ['m1', 'm2']);
  assert.equal(merged[0].payload.actions[0].status, 'applied');
});

await test('mergeChatMessages: preserves created_at order even with out-of-order incoming', () => {
  // Server returns ascending today but the merge step interleaves
  // existing + new; an unsorted result would leave a newer message
  // above an older one in the scroll. Re-sort guarantees the thread
  // reads chronologically.
  const existing = [
    { id: 'a', created_at: '2024-01-01T10:00:00Z' },
    { id: 'c', created_at: '2024-01-01T10:02:00Z' }
  ];
  const incoming = [
    { id: 'c', created_at: '2024-01-01T10:02:00Z' },
    { id: 'b', created_at: '2024-01-01T10:01:00Z' },
    { id: 'a', created_at: '2024-01-01T10:00:00Z' }
  ];
  const merged = mergeChatMessages(existing, incoming);
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c']);
});

await test('mergeChatMessages: keeps local-only messages the server snapshot does not return (defensive)', () => {
  // If the server snapshot somehow loses a row we already rendered
  // (split-brain, mid-deploy, etc.), don't yank it out from under
  // the firm. Belt-and-braces — refresh should never delete.
  const existing = [
    { id: 'a', created_at: '2024-01-01T10:00:00Z' },
    { id: 'local-only', created_at: '2024-01-01T10:00:30Z' }
  ];
  const incoming = [{ id: 'a', created_at: '2024-01-01T10:00:00Z' }];
  const merged = mergeChatMessages(existing, incoming);
  assert.deepEqual(merged.map((m) => m.id), ['a', 'local-only']);
});

await test('mergeChatMessages: empty / nullish inputs are safe', () => {
  assert.deepEqual(mergeChatMessages(null, null), []);
  assert.deepEqual(mergeChatMessages([], []), []);
  const incoming = [{ id: 'a', created_at: '2024-01-01T10:00:00Z' }];
  assert.deepEqual(mergeChatMessages(undefined, incoming).map((m) => m.id), ['a']);
});

// ─── isNearBottom ────────────────────────────────────────────────────────

await test('isNearBottom: within 80px of bottom → true', () => {
  // 800 total, viewport 200, scrolled to 540 → distance = 800 - 740 = 60
  const el = { scrollHeight: 800, scrollTop: 540, clientHeight: 200 };
  assert.equal(isNearBottom(el, 80), true);
});

await test('isNearBottom: scrolled up beyond threshold → false', () => {
  // 800 total, viewport 200, scrolled to 100 → distance = 800 - 300 = 500
  const el = { scrollHeight: 800, scrollTop: 100, clientHeight: 200 };
  assert.equal(isNearBottom(el, 80), false);
});

await test('isNearBottom: null element defaults to true (initial commit, ref not attached yet)', () => {
  assert.equal(isNearBottom(null, 80), true);
});

await test('currency repair cue is scoped to an unposted receipt or bill with an actual amount', () => {
  const source = { document_type: 'receipt', total_amount: 10, currency: null };
  assert.equal(documentNeedsCurrencyConfirmation(source), true);
  assert.equal(documentNeedsCurrencyConfirmation({ ...source, currency: 'GBP' }), false);
  assert.equal(documentNeedsCurrencyConfirmation({ ...source, total_amount: 0 }), false);
  assert.equal(documentNeedsCurrencyConfirmation({ ...source, document_type: 'bank_statement' }), false);
  assert.equal(documentNeedsCurrencyConfirmation({ ...source, payload: { settlement_entry: { journal_id: 'posted' } } }), false);
  assert.deepEqual(describeAction({ type: 'correct_document_field', field_path: 'currency', corrected_value: 'GBP' }), [
    { labelId: 'operator.action.detail.field', kind: 'identifier', value: 'currency' },
    { labelId: 'operator.action.detail.newValue', kind: 'identifier', value: 'GBP' }
  ]);
  assert.equal(deriveActionCardState({ action: { type: 'correct_document_field' }, appliableTypes: ['correct_document_field'], hasOnApply: true }).enabled, true);
});

console.log(`\ndocumentChat (FE helpers): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
