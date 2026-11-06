import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEDGER_ADJUSTMENT_INSTRUCTION,
  LINE_HANGING_WARNING,
  MEMORY_STATUS_COPY,
  REVERSE_DISPOSITION_META,
  REVERSE_REASON_COPY,
  SURFACED_KIND_LABELS,
  REVERSE_WRITER_LABELS,
  buildReversePlanView,
  buildReverseReceiptView,
  canExecuteReverse,
  initialReverseUiState,
  reverseReasonCopy,
  reverseUiReduce,
  selectedReverseCount
} from './reversePlanView.js';

// ── Plan-render fidelity ────────────────────────────────────────────────────

const PLAN_RESPONSE = {
  dry_run: true,
  client_id: 'client-1',
  summary: { total: 6, reverse: 2, stale: 2, needs_ledger_adjustment: 1, skip: 1, surfaced: 1 },
  cards: [
    {
      proposal_id: 'card-coding',
      writer: 'updateTransactionReviewItemInDb',
      leg: 'review_item',
      proposal_type: 'feed_chat_apply',
      status: 'applied',
      created_at: '2026-08-15T10:00:00Z',
      summary: { total: 3, reverse: 1, stale: 1, needs_ledger_adjustment: 1, skip: 0, surfaced: 1 },
      entries: [
        {
          target: 'tx-1',
          disposition: 'reverse',
          patch: { category: 'Travel' },
          preconditions: { object: 'tx-1', expected_status: 'categorized' },
          surfaced: [
            {
              kind: 'rule_confirmation_bump',
              reversed: false,
              reason: 'a confirmation is evidence of a past confirm — a reverse does not rewrite history',
              rule_id: 'rule-9',
              review_item_id: 'ri-4',
              prior_count: 1,
              confirmation_count: 2,
              confidence: 'suggest'
            }
          ]
        },
        { target: 'tx-2', disposition: 'stale', reason: 'status_moved', expected: 'categorized', actual: 'approved' },
        { target: 'tx-3', disposition: 'needs_ledger_adjustment', reason: 'posted_to_ledger' }
      ]
    },
    {
      proposal_id: 'card-ask',
      writer: 'createClientEvidenceRequestInDb',
      leg: 'ask',
      proposal_type: 'transaction_chat_apply',
      status: 'applied',
      created_at: '2026-08-15T09:00:00Z',
      summary: { total: 2, reverse: 1, stale: 1, needs_ledger_adjustment: 0, skip: 0, surfaced: 0 },
      entries: [
        { target: 'ask-1', kind: 'client_evidence_request', disposition: 'reverse' },
        { target: 'ask-2', kind: 'client_evidence_request', disposition: 'stale', reason: 'ask_answered', expected: 'open', actual: 'replied' }
      ]
    },
    {
      proposal_id: 'card-resend',
      writer: 'deliverEvidenceAsksOnAllChannels',
      leg: null,
      summary: { total: 1, reverse: 0, stale: 0, needs_ledger_adjustment: 0, skip: 1, surfaced: 0 },
      entries: [{ target: 'ask-3', disposition: 'skip', reason: 'outbound_never_auto_fired', writer: 'deliverEvidenceAsksOnAllChannels' }]
    }
  ]
};

test('plan view keeps every card, every entry, and all four dispositions', () => {
  const view = buildReversePlanView(PLAN_RESPONSE);
  assert.equal(view.dryRun, true);
  assert.equal(view.cards.length, 3);
  const dispositions = view.cards.flatMap((c) => c.entries.map((e) => e.disposition));
  for (const d of ['reverse', 'stale', 'needs_ledger_adjustment', 'skip']) {
    assert.ok(dispositions.includes(d), `plan view must carry disposition ${d}`);
  }
  // The summary is echoed, surfaced count included — a report count, not a
  // fifth disposition.
  assert.deepEqual(view.summary, {
    total: 6, reverse: 2, stale: 2, needs_ledger_adjustment: 1, skip: 1, surfaced: 1
  });
  assert.equal(Object.keys(REVERSE_DISPOSITION_META).length, 4);
});

test('a needs_ledger_adjustment row carries the adjustment-journal instruction verbatim', () => {
  const view = buildReversePlanView(PLAN_RESPONSE);
  const ledgerRow = view.cards[0].entries.find((e) => e.disposition === 'needs_ledger_adjustment');
  assert.equal(ledgerRow.instruction, LEDGER_ADJUSTMENT_INSTRUCTION);
  assert.equal(ledgerRow.reasonCopy, LEDGER_ADJUSTMENT_INSTRUCTION);
  assert.match(LEDGER_ADJUSTMENT_INSTRUCTION, /dated adjustment journal/);
  assert.match(LEDGER_ADJUSTMENT_INSTRUCTION, /never un-posts silently/);
});

test('surfaced side effects are rendered, never dropped: what stays taught is visible', () => {
  const view = buildReversePlanView(PLAN_RESPONSE);
  const withSurfaced = view.cards[0].entries[0];
  assert.equal(withSurfaced.surfaced.length, 1);
  const bump = withSurfaced.surfaced[0];
  assert.equal(bump.label, SURFACED_KIND_LABELS.rule_confirmation_bump);
  // The server's own sentence rides verbatim as the detail.
  assert.match(bump.detail, /does not rewrite history/);
  // PR-13's stamp: WHICH review item drove the bump is part of the render.
  assert.equal(bump.reviewItemId, 'ri-4');
  assert.equal(bump.priorCount, 1);
  assert.equal(bump.confirmationCount, 2);
  // Both surfaced kinds have labels.
  assert.ok(SURFACED_KIND_LABELS.rule_cascade_not_unwound);
});

test('the memory-shaped reasons all have their own copy (the PR-14 builder note)', () => {
  const memoryShaped = [
    'firm_fact_pre_existed',
    'client_rule_pre_existed',
    'client_evidence_request_pre_existed',
    'ask_answered',
    'already_reversed',
    'ask_reopen_not_auto_planned',
    'ask_amendment_not_auto_reverted',
    'outbound_never_auto_fired'
  ];
  for (const reason of memoryShaped) {
    const copy = REVERSE_REASON_COPY[reason];
    assert.ok(copy, `reason ${reason} must have copy`);
    assert.notEqual(copy, reason, `reason ${reason} must not fall back to its raw token`);
  }
  // The answered-ask copy states the refusal's ground: the owner's answer wins.
  assert.match(REVERSE_REASON_COPY.ask_answered, /owner answered/i);
});

test('every non-memory reason token the executor emits has copy too', () => {
  for (const reason of [
    'malformed_before_after_row', 'not_reversible', 'empty_before_state',
    'not_match_shaped', 'cascade_cannot_restore', 'not_memory_mint_shaped',
    'target_missing', 'writer_not_supported',
    'status_moved', 'review_state_moved', 'match_status_moved', 'reconciliation_status_moved',
    'posted_to_ledger', 'fact_not_active', 'ask_not_cancellable', 'review_item_not_found'
  ]) {
    assert.ok(REVERSE_REASON_COPY[reason], `reason ${reason} must have copy`);
  }
});

test('an unknown reason renders as its raw token, never as silence', () => {
  assert.equal(reverseReasonCopy('some_future_reason'), 'some_future_reason');
  assert.equal(reverseReasonCopy(null), '');
});

test('a stale row says what moved: recorded expected vs current actual', () => {
  const view = buildReversePlanView(PLAN_RESPONSE);
  const stale = view.cards[0].entries.find((e) => e.disposition === 'stale');
  assert.deepEqual(stale.movement, { expected: 'categorized', actual: 'approved' });
  const answered = view.cards[1].entries.find((e) => e.reason === 'ask_answered');
  assert.deepEqual(answered.movement, { expected: 'open', actual: 'replied' });
});

test('cards echo which apply they were and name their writer', () => {
  const view = buildReversePlanView(PLAN_RESPONSE);
  const coding = view.cards[0];
  assert.equal(coding.writerLabel, REVERSE_WRITER_LABELS.updateTransactionReviewItemInDb);
  assert.equal(coding.proposalType, 'feed_chat_apply');
  assert.equal(coding.createdAt, '2026-08-15T10:00:00Z');
  // A surfaced-only writer still gets a NAMED label, not a blank.
  const resend = view.cards[2];
  assert.equal(resend.writerLabel, REVERSE_WRITER_LABELS.deliverEvidenceAsksOnAllChannels);
  assert.equal(resend.selectable, false);
  assert.equal(coding.selectable, true);
});

test('selectedReverseCount sums only the selected cards writable rows', () => {
  const view = buildReversePlanView(PLAN_RESPONSE);
  assert.equal(selectedReverseCount(view, ['card-coding']), 1);
  assert.equal(selectedReverseCount(view, ['card-coding', 'card-ask']), 2);
  assert.equal(selectedReverseCount(view, ['card-resend']), 0);
  assert.equal(selectedReverseCount(view, []), 0);
});

// ── Receipt fidelity ────────────────────────────────────────────────────────

test('the receipt renders retire verbs, hanging-line verdicts, skips and errors', () => {
  const receipt = buildReverseReceiptView({
    dry_run: false,
    client_id: 'client-1',
    summary: { total: 4, reverse: 3, stale: 0, needs_ledger_adjustment: 0, skip: 1, surfaced: 0, reversed: 2, errors: 1 },
    applied: [
      { proposal_id: 'p1', target: 'fact-1', kind: 'firm_fact', status: 'reversed', memory_status: 'dismissed' },
      { proposal_id: 'p2', target: 'ask-1', kind: 'client_evidence_request', status: 'reversed', memory_status: 'cancelled', leaves_line_hanging: true },
      { proposal_id: 'p3', target: 'tx-9', status: 'skipped', reason: 'review_item_not_found' },
      { proposal_id: 'p4', target: 'tx-8', status: 'error', reason: 'boom' }
    ]
  });
  assert.equal(receipt.summary.reversed, 2);
  assert.equal(receipt.summary.errors, 1);
  const [fact, ask, skipped, errored] = receipt.applied;
  assert.equal(fact.memoryStatusCopy, MEMORY_STATUS_COPY.dismissed);
  assert.match(MEMORY_STATUS_COPY.dismissed, /content is kept/);
  assert.match(MEMORY_STATUS_COPY.retired, /history is kept/);
  // The FIRST-principle verdict from the cancel writer is loud, not a footnote.
  assert.equal(ask.leavesLineHanging, true);
  assert.equal(receipt.hangingCount, 1);
  assert.match(LINE_HANGING_WARNING, /neither terminal/);
  assert.equal(skipped.statusLabel, 'Skipped');
  assert.equal(skipped.reasonCopy, REVERSE_REASON_COPY.review_item_not_found);
  assert.equal(errored.tone, 'alert');
  assert.equal(errored.reasonCopy, 'boom');
});

// ── Execute-only-on-confirm ─────────────────────────────────────────────────

test('execute is only reachable from an armed confirm', () => {
  let state = initialReverseUiState;
  // From loading: nothing executes.
  assert.equal(canExecuteReverse(state), false);
  assert.equal(reverseUiReduce(state, { type: 'execute_start' }).phase, 'loading');
  state = reverseUiReduce(state, { type: 'plan_loaded' });
  assert.equal(state.phase, 'plan');
  // From plan, even with a selection, execute is refused: no confirm yet.
  state = reverseUiReduce(state, { type: 'toggle', id: 'card-coding' });
  assert.deepEqual(state.selected, ['card-coding']);
  assert.equal(canExecuteReverse(state), false);
  assert.equal(reverseUiReduce(state, { type: 'execute_start' }).phase, 'plan');
  // Confirm with an empty selection is refused.
  const cleared = reverseUiReduce(state, { type: 'clear_selection' });
  assert.equal(reverseUiReduce(cleared, { type: 'request_confirm' }).phase, 'plan');
  // Confirm with a selection arms execute.
  state = reverseUiReduce(state, { type: 'request_confirm' });
  assert.equal(state.phase, 'confirm');
  assert.equal(canExecuteReverse(state), true);
  state = reverseUiReduce(state, { type: 'execute_start' });
  assert.equal(state.phase, 'executing');
  assert.equal(reverseUiReduce(state, { type: 'execute_done' }).phase, 'receipt');
});

test('cancel and failure drop back without losing the selection', () => {
  let state = reverseUiReduce(initialReverseUiState, { type: 'plan_loaded' });
  state = reverseUiReduce(state, { type: 'toggle', id: 'a' });
  state = reverseUiReduce(state, { type: 'request_confirm' });
  const cancelled = reverseUiReduce(state, { type: 'cancel_confirm' });
  assert.equal(cancelled.phase, 'plan');
  assert.deepEqual(cancelled.selected, ['a']);
  const executing = reverseUiReduce(state, { type: 'execute_start' });
  const failed = reverseUiReduce(executing, { type: 'execute_failed', message: 'nope' });
  assert.equal(failed.phase, 'confirm');
  assert.equal(failed.error, 'nope');
  assert.deepEqual(failed.selected, ['a']);
});

test('toggling is a plan-phase act; selection cannot drift mid-confirm', () => {
  let state = reverseUiReduce(initialReverseUiState, { type: 'plan_loaded' });
  state = reverseUiReduce(state, { type: 'toggle', id: 'a' });
  state = reverseUiReduce(state, { type: 'request_confirm' });
  // While confirming, a toggle is ignored: the confirm screen describes a
  // fixed selection, and mutating it under the button would confirm the wrong set.
  const toggled = reverseUiReduce(state, { type: 'toggle', id: 'b' });
  assert.deepEqual(toggled.selected, ['a']);
  const untoggled = reverseUiReduce(state, { type: 'toggle', id: 'a' });
  assert.deepEqual(untoggled.selected, ['a']);
});
