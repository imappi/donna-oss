// RT-16 — the ONE coding state machine (codingState.js). Pins the transition
// table, the legacy ↔ machine mappings (the migration 138 backfill law and
// the DTO projection), the patch derivation, and the write-through helper's
// refusal — every table the migration header, the writers and the
// convergence derivation lean on.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODING_STATES,
  CODING_STATE_TRANSITIONS,
  CODING_STATE_NONE_KEY,
  CodingStateTransitionError,
  codingTransitionAllowed,
  codingStatesAllowingTransitionTo,
  codingTransitionGuardSql,
  assertCodingTransition,
  TRANSACTION_REVIEW_STATES,
  normalizeTransactionReviewState,
  deriveTransactionReviewState,
  CODING_STATE_FROM_REVIEW_STATE,
  codingStateFromReviewState,
  LEGACY_REVIEW_STATE_FOR_CODING_STATE,
  legacyReviewStateFor,
  APPLIED_SUGGESTION_RECEIPTS,
  DECIDED_CODING_STATES,
  isDecidedCodingState,
  RECONCILED_CODING_STATES,
  HANGING_CODING_STATES,
  OWNER_CODING_STATE,
  codingStateReasonKey,
  codingStateClosesReviewCase,
  reviewCaseClosesForLegacyState,
  nextCodingStateForPatch,
  CODING_STATE_RANK,
  codingStateFromLegacy,
  applyCodingTransition,
  applyCodingTransitionIfAllowed
} from './codingState.js';
import { DECIDED_TRANSACTION_REVIEW_STATES } from './firmDb.js';

test('the machine: seven states, every declared transition, nothing else', () => {
  assert.deepEqual([...CODING_STATES], ['proposed', 'applied', 'asked', 'held', 'posted', 'synced', 'closed']);
  assert.deepEqual(Object.keys(CODING_STATE_TRANSITIONS).sort(), [CODING_STATE_NONE_KEY, ...CODING_STATES].sort());
  // Every open state may reach every open state plus the ledger facts.
  for (const from of [CODING_STATE_NONE_KEY, 'proposed', 'asked', 'held']) {
    for (const to of ['proposed', 'applied', 'asked', 'held', 'posted', 'synced']) {
      assert.equal(codingTransitionAllowed(from === CODING_STATE_NONE_KEY ? null : from, to), true, `${from} → ${to}`);
    }
    assert.equal(codingTransitionAllowed(from === CODING_STATE_NONE_KEY ? null : from, 'closed'), false, `${from} → closed is not a close-path move`);
  }
  // applied may also close.
  assert.equal(codingTransitionAllowed('applied', 'closed'), true);
  assert.equal(codingTransitionAllowed('applied', 'proposed'), true, 'a reverse (pod-safety #2) re-opens an applied line');
  // The ledger facts never go back to an open state.
  for (const from of ['posted', 'synced']) {
    for (const to of ['proposed', 'applied', 'asked', 'held']) {
      assert.equal(codingTransitionAllowed(from, to), false, `${from} → ${to} needs a ledger adjustment, not a state flip`);
    }
    assert.equal(codingTransitionAllowed(from, 'posted'), true);
    assert.equal(codingTransitionAllowed(from, 'synced'), true);
    assert.equal(codingTransitionAllowed(from, 'closed'), true);
  }
  // closed is terminal.
  for (const to of CODING_STATES) assert.equal(codingTransitionAllowed('closed', to), to === 'closed', `closed → ${to}`);
  // Unknown targets are never allowed; the none key reads null and ''.
  assert.equal(codingTransitionAllowed(null, 'suggested'), false);
  assert.equal(codingTransitionAllowed('', 'proposed'), true);
  assert.equal(codingTransitionAllowed('mystery', 'proposed'), false);
});

test('assertCodingTransition refuses with a typed 409 and normalizes on success', () => {
  assert.equal(assertCodingTransition(null, 'Proposed'), 'proposed');
  assert.throws(() => assertCodingTransition('posted', 'proposed', { transactionId: 'tx-1' }), (error) => {
    assert.ok(error instanceof CodingStateTransitionError);
    assert.equal(error.code, 'CODING_STATE_TRANSITION_INVALID');
    assert.equal(error.statusCode, 409);
    assert.deepEqual([error.from, error.to, error.transactionId], ['posted', 'proposed', 'tx-1']);
    return true;
  });
  assert.throws(() => assertCodingTransition(null, 'suggested'), CodingStateTransitionError, 'a legacy label is not a machine state');
});

test('the SQL guard names exactly the FROM states a target is reachable from', () => {
  assert.deepEqual(codingStatesAllowingTransitionTo('proposed'), [CODING_STATE_NONE_KEY, 'proposed', 'applied', 'asked', 'held']);
  assert.equal(codingTransitionGuardSql('proposed'), "(coding_state is null or coding_state in ('proposed', 'applied', 'asked', 'held'))");
  assert.equal(codingTransitionGuardSql('closed', 't.coding_state'), "(t.coding_state in ('applied', 'posted', 'synced', 'closed'))");
  assert.equal(codingTransitionGuardSql('suggested'), 'false');
});

test('legacy label ↔ machine state: total in both directions, DECIDED byte-identical', () => {
  assert.deepEqual([...TRANSACTION_REVIEW_STATES].sort(), Object.keys(CODING_STATE_FROM_REVIEW_STATE).sort(), 'every legacy label maps');
  for (const label of TRANSACTION_REVIEW_STATES) assert.ok(CODING_STATES.includes(CODING_STATE_FROM_REVIEW_STATE[label]), label);
  assert.deepEqual([...CODING_STATES].sort(), Object.keys(LEGACY_REVIEW_STATE_FOR_CODING_STATE).sort(), 'every machine state projects');
  // Round trip: project then map returns the same state.
  for (const state of CODING_STATES) assert.equal(codingStateFromReviewState(legacyReviewStateFor(state)), state, state);
  // Aliases still normalize on input.
  assert.equal(codingStateFromReviewState('needs_client'), 'asked');
  assert.equal(codingStateFromReviewState('Asked Client'), 'asked');
  assert.equal(codingStateFromReviewState('ledger_posted'), 'posted');
  assert.equal(codingStateFromReviewState('nope'), null);
  assert.equal(legacyReviewStateFor(null), null);
  // The close path's decided set is the image of DECIDED_TRANSACTION_REVIEW_STATES.
  const image = new Set(DECIDED_TRANSACTION_REVIEW_STATES.map(codingStateFromReviewState));
  assert.deepEqual([...image].sort(), [...DECIDED_CODING_STATES].sort());
  for (const state of DECIDED_CODING_STATES) assert.ok(DECIDED_TRANSACTION_REVIEW_STATES.includes(legacyReviewStateFor(state)), state);
  for (const state of CODING_STATES) assert.equal(isDecidedCodingState(state), DECIDED_CODING_STATES.includes(state));
  assert.equal(isDecidedCodingState(null), false);
  // The convergence partition covers the machine exactly once.
  assert.deepEqual(
    [...RECONCILED_CODING_STATES, OWNER_CODING_STATE, ...HANGING_CODING_STATES].sort(),
    [...CODING_STATES].sort()
  );
  assert.equal(codingStateReasonKey('proposed'), 'coding_state:proposed');
  assert.deepEqual(APPLIED_SUGGESTION_RECEIPTS, ['applied', 'alternative_applied', 'reviewer_applied', 'auto_applied']);
});

test('review-case closing: the column closes on the ledger/hold states, the legacy input on resolved too', () => {
  for (const state of ['posted', 'synced', 'closed', 'held']) assert.equal(codingStateClosesReviewCase(state), true, state);
  for (const state of ['proposed', 'applied', 'asked', null]) assert.equal(codingStateClosesReviewCase(state), false, String(state));
  assert.equal(reviewCaseClosesForLegacyState('resolved'), true, 'an explicit "resolved" still closes the case');
  assert.equal(reviewCaseClosesForLegacyState('accepted'), false, 'an accept keeps the case open until it posts');
  assert.equal(reviewCaseClosesForLegacyState('dismissed'), true);
});

test('deriveTransactionReviewState keeps its legacy semantics (moved from firmDb.js)', () => {
  assert.equal(normalizeTransactionReviewState('asked client'), 'asked_client');
  assert.equal(normalizeTransactionReviewState('xero_synced'), 'synced');
  assert.equal(deriveTransactionReviewState({ payload: {} }), 'suggested');
  assert.equal(deriveTransactionReviewState({ payload: { ai_suggestion_status: 'applied' } }), 'accepted');
  assert.equal(deriveTransactionReviewState({ payload: {}, patch: { reviewer_note: 'Client evidence request created.' } }), 'waiting');
  assert.equal(deriveTransactionReviewState({ payload: {}, status: 'cancelled' }), 'resolved');
});

test('nextCodingStateForPatch: explicit first, then the legacy signals, else the current state stands', () => {
  // Explicit machine vocabulary wins over everything.
  assert.equal(nextCodingStateForPatch({ currentState: 'proposed', patch: { coding_state: 'applied', review_state: 'waiting' } }), 'applied');
  // Explicit legacy label.
  assert.equal(nextCodingStateForPatch({ currentState: null, patch: { review_state: 'accepted' } }), 'applied');
  assert.equal(nextCodingStateForPatch({ currentState: 'applied', patch: { reviewState: 'suggested' } }), 'proposed', 'a reverse sends the before-state label back');
  // The SPA's transaction Apply: an applied receipt, no label.
  assert.equal(nextCodingStateForPatch({ currentState: 'proposed', patch: { ai_suggestion_status: 'applied' } }), 'applied');
  assert.equal(nextCodingStateForPatch({ currentState: null, patch: { ai_suggestion_status: 'reviewer_applied' } }), 'applied');
  // The ask lane's stamps.
  assert.equal(nextCodingStateForPatch({ currentState: 'proposed', patch: { status: 'needs_client' } }), 'asked');
  assert.equal(nextCodingStateForPatch({ currentState: 'applied', patch: { evidence_request: { status: 'open', sent_at: 1 } } }), 'asked');
  // The Xero markers.
  assert.equal(nextCodingStateForPatch({ currentState: 'applied', patch: { xero_sync_status: 'synced' } }), 'synced');
  // A closing case status is a decision.
  assert.equal(nextCodingStateForPatch({ currentState: 'proposed', patch: {}, itemStatus: 'cancelled' }), 'applied');
  // No signal: the state stands — a description edit never mints a proposal.
  assert.equal(nextCodingStateForPatch({ currentState: null, patch: { description: 'x' } }), null);
  assert.equal(nextCodingStateForPatch({ currentState: 'posted', patch: { description: 'x' } }), 'posted');
  assert.equal(nextCodingStateForPatch({ currentState: 'asked', patch: { reviewer_note: 'looked at it' } }), 'asked');
});

// The migration 138 mapping table, row by row (the PG fixture seeds the same
// rows and reads the column back; this pins the JS law they compare against).
test('codingStateFromLegacy — the backfill law: highest rank wins, a bare "suggested" needs a proposal', () => {
  assert.deepEqual(CODING_STATE_RANK, { proposed: 1, applied: 2, asked: 3, held: 4, posted: 5, synced: 6, closed: 7 });
  const rows = [
    // [label, inputs, expected]
    ['1 closed anywhere', { queueReviewState: 'closed', payloadReviewState: 'accepted' }, 'closed'],
    ['2 synced label', { payloadReviewState: 'synced', aiSuggestionStatus: 'auto_applied' }, 'synced'],
    ['2b synced marker with an accepted label', { payloadReviewState: 'accepted', xeroSynced: true }, 'synced'],
    ['3 posted label', { queueReviewState: 'posted' }, 'posted'],
    ['3b ledger marker with an accepted label', { queuePayloadReviewState: 'accepted', ledgerPosted: true }, 'posted'],
    ['4 held', { queueReviewState: 'held', payloadReviewState: 'suggested', hasProposal: true }, 'held'],
    ['5 asked_client', { queueReviewState: 'asked_client', aiSuggestionStatus: 'suggested' }, 'asked'],
    ['5b waiting on the transaction, accepted receipt on the queue', { queuePayloadReviewState: 'accepted', payloadReviewState: 'waiting' }, 'asked'],
    ['6 accepted', { queueReviewState: 'accepted' }, 'applied'],
    ['6b resolved', { payloadReviewState: 'resolved' }, 'applied'],
    ['6c the parse-time desync: column suggested, payload accepted, rule-coded', { queueReviewState: 'suggested', queuePayloadReviewState: 'accepted', queueHasProposal: true }, 'applied'],
    ['6d applied receipt only (the SPA Apply on the artifact)', { payloadReviewState: 'suggested', aiSuggestionStatus: 'applied', hasProposal: true }, 'applied'],
    ['7 suggested with a coder verdict', { queueReviewState: 'suggested', payloadReviewState: 'suggested', aiSuggestionStatus: 'suggested', hasProposal: true }, 'proposed'],
    ['7b suggested receipt alone', { aiSuggestionStatus: 'suggested' }, 'proposed'],
    ['7c suggested label + queue proposal', { queueReviewState: 'suggested', queueHasProposal: true }, 'proposed'],
    ['8 no label, needs_client stamp', { needsClient: true }, 'asked'],
    ['9 no label, a closed case', { queueStatus: 'resolved' }, 'applied'],
    ['9b no label, a cancelled case', { queueStatus: 'cancelled' }, 'applied'],
    ['10 the case-file row: suggested with NO proposal anywhere', { queueReviewState: 'suggested', queuePayloadReviewState: 'suggested' }, null],
    ['10b suggested + open case + no proposal', { queueReviewState: 'suggested', queueStatus: 'open' }, null],
    ['11 nothing', {}, null],
    ['12 a suggested label outranked by a needs_client fallback? no — labels first, only when none', { queueReviewState: 'suggested', queueHasProposal: true, needsClient: true }, 'proposed']
  ];
  for (const [label, inputs, expected] of rows) {
    assert.equal(codingStateFromLegacy(inputs), expected, label);
  }
});

test('applyCodingTransition: locks, refuses undeclared moves, writes only on change', async () => {
  const calls = [];
  const client = (state, found = true) => ({
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^select coding_state/.test(sql.trim())) return { rows: found ? [{ coding_state: state }] : [] };
      return { rows: [], rowCount: 1 };
    }
  });
  // none → proposed writes.
  let out = await applyCodingTransition(client(null), { firmId: 'f', transactionId: 'tx', to: 'proposed' });
  assert.deepEqual(out, { found: true, from: null, to: 'proposed', changed: true });
  assert.match(calls[0].sql, /for update/);
  assert.match(calls[1].sql, /set coding_state = \$3, coding_state_as_of = now\(\)/);
  assert.deepEqual(calls[1].params, ['f', 'tx', 'proposed']);
  // self-move: no write.
  calls.length = 0;
  out = await applyCodingTransition(client('proposed'), { firmId: 'f', transactionId: 'tx', to: 'proposed' });
  assert.deepEqual(out, { found: true, from: 'proposed', to: 'proposed', changed: false });
  assert.equal(calls.length, 1);
  // refused: posted → proposed.
  calls.length = 0;
  await assert.rejects(
    () => applyCodingTransition(client('posted'), { firmId: 'f', transactionId: 'tx', to: 'proposed' }),
    (error) => error.code === 'CODING_STATE_TRANSITION_INVALID' && error.from === 'posted'
  );
  assert.equal(calls.length, 1, 'nothing written after a refusal');
  // missing row.
  out = await applyCodingTransition(client(null, false), { firmId: 'f', transactionId: 'gone', to: 'applied' });
  assert.deepEqual(out, { found: false, from: null, to: 'applied', changed: false });
  // a legacy label is not a target.
  await assert.rejects(() => applyCodingTransition(client(null), { firmId: 'f', transactionId: 'tx', to: 'accepted' }), CodingStateTransitionError);
});

test('applyCodingTransitionIfAllowed: the ask stamps skip a ledger rung instead of throwing', async () => {
  const calls = [];
  const client = (state) => ({
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^select coding_state/.test(sql.trim())) return { rows: [{ coding_state: state }] };
      return { rows: [], rowCount: 1 };
    }
  });
  let out = await applyCodingTransitionIfAllowed(client('posted'), { firmId: 'f', transactionId: 'tx', to: 'asked' });
  assert.deepEqual(out, { found: true, from: 'posted', to: 'asked', changed: false, skipped: true });
  assert.equal(calls.length, 1, 'read only');
  calls.length = 0;
  out = await applyCodingTransitionIfAllowed(client('proposed'), { firmId: 'f', transactionId: 'tx', to: 'asked' });
  assert.deepEqual(out, { found: true, from: 'proposed', to: 'asked', changed: true, skipped: false });
  assert.equal(calls.length, 2);
});
