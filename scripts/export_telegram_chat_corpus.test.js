import test from 'node:test';
import assert from 'node:assert/strict';

import { LANES, laneForAnchor, classifyTurn, pairThreadTurns } from './export_telegram_chat_corpus.js';

// ── lane attribution ────────────────────────────────────────────────────────
//
// inboundCore.js tries five handlers in order; each writes its own anchor into
// the delivery ledger. A general question answered by lanes 1-4 is a ROUTING
// defect, and the anchor is the only way to see it from data.

test('laneForAnchor maps every anchor inboundCore.js actually writes', () => {
  assert.equal(laneForAnchor('invoice_issuance_intent'), 'lane1_invoice_issuance');
  assert.equal(laneForAnchor('owner_invoice_command'), 'lane2_owner_invoice');
  assert.equal(laneForAnchor('einvoice_inbound'), 'lane3_einvoice_media');
  assert.equal(laneForAnchor('owner_initiated_media'), 'lane4_owner_media');
  assert.equal(laneForAnchor('general_owner_chat'), 'lane5_general_chat');
  assert.equal(Object.keys(LANES).length, 5);
});

test('laneForAnchor: a ledger row with no anchor is the anchored-ask reply path', () => {
  assert.equal(laneForAnchor(null), 'anchored_ask_reply');
  assert.equal(laneForAnchor(undefined), 'anchored_ask_reply');
});

test('laneForAnchor surfaces an unknown anchor instead of swallowing it', () => {
  assert.equal(laneForAnchor('some_future_lane'), 'unknown:some_future_lane');
});

// ── turn classification ─────────────────────────────────────────────────────

test('classifyTurn: a missing assistant row is the unavailable path, not a bad answer', () => {
  const result = classifyTurn({ userRow: { content: 'what is my profit?' }, assistantRow: null });
  assert.equal(result.outcome, 'no_assistant_row');
  assert.match(result.detail, /reason not persisted/);
});

test('classifyTurn: the memory short-circuit is distinguishable and made no model call', () => {
  const result = classifyTurn({
    userRow: {},
    assistantRow: { payload: { memory_status: 'blocked', actions: [] } }
  });
  assert.equal(result.outcome, 'memory_short_circuit');
  assert.match(result.detail, /no model call/);
});

test('classifyTurn: a report turn is flagged so the SECOND model call is not misread as the chat call', () => {
  const result = classifyTurn({
    userRow: {},
    assistantRow: {
      model: 'claude-opus-4-8',
      payload: { report_request: { period_start: '2026-01-01', period_end: '2026-01-31' }, actions: [] }
    }
  });
  assert.equal(result.outcome, 'report_narration');
  assert.match(result.detail, /narration/);
});

test('classifyTurn: an applied action is read off the persisted receipt', () => {
  const result = classifyTurn({
    userRow: {},
    assistantRow: { payload: { applied_action: { type: 'record_mileage' }, actions: [] } }
  });
  assert.equal(result.outcome, 'action_applied');
  assert.match(result.detail, /record_mileage/);
});

test('classifyTurn: the ledger action_applied flag is a fallback when the payload lacks one', () => {
  const result = classifyTurn({
    userRow: {},
    assistantRow: { payload: { actions: [] } },
    ledger: { anchor: 'general_owner_chat', action_applied: true }
  });
  assert.equal(result.outcome, 'action_applied');
});

test('classifyTurn: an ordinary answer is a plain single-call turn', () => {
  const result = classifyTurn({
    userRow: {},
    assistantRow: { model: 'claude-opus-4-8', payload: { actions: [] } },
    ledger: { anchor: 'general_owner_chat', action_applied: false }
  });
  assert.equal(result.outcome, 'plain_answer');
});

test('classifyTurn tolerates a null/!object payload without throwing', () => {
  assert.equal(classifyTurn({ userRow: {}, assistantRow: { payload: null } }).outcome, 'plain_answer');
  assert.equal(classifyTurn({ userRow: {}, assistantRow: { payload: 'nonsense' } }).outcome, 'plain_answer');
});

// ── pairing ─────────────────────────────────────────────────────────────────

test('pairThreadTurns pairs each user row with the assistant row that follows it', () => {
  const turns = pairThreadTurns([
    { id: 'u1', role: 'user', created_at: '2026-07-01T10:00:00Z' },
    { id: 'a1', role: 'assistant', created_at: '2026-07-01T10:00:05Z' },
    { id: 'u2', role: 'user', created_at: '2026-07-01T10:01:00Z' },
    { id: 'a2', role: 'assistant', created_at: '2026-07-01T10:01:05Z' }
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].userRow.id, 'u1');
  assert.equal(turns[0].assistantRow.id, 'a1');
  assert.equal(turns[1].assistantRow.id, 'a2');
});

test('pairThreadTurns leaves a user row orphaned when no assistant reply was persisted', () => {
  // This is the shape the general_chat_unavailable path leaves behind: the user
  // row is written BEFORE the model call, the assistant row never is.
  const turns = pairThreadTurns([
    { id: 'u1', role: 'user', created_at: '2026-07-01T10:00:00Z' },
    { id: 'u2', role: 'user', created_at: '2026-07-01T10:01:00Z' },
    { id: 'a2', role: 'assistant', created_at: '2026-07-01T10:01:05Z' }
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].assistantRow, null);
  assert.equal(turns[1].assistantRow.id, 'a2');
});

test('pairThreadTurns does not reach past the next user row for a reply', () => {
  const turns = pairThreadTurns([
    { id: 'u1', role: 'user', created_at: '2026-07-01T10:00:00Z' },
    { id: 'u2', role: 'user', created_at: '2026-07-01T10:00:30Z' },
    { id: 'a2', role: 'assistant', created_at: '2026-07-01T10:00:35Z' }
  ]);
  assert.equal(turns[0].assistantRow, null, 'u1 must not steal u2 reply');
});

test('pairThreadTurns skips a system row without treating it as the answer', () => {
  const turns = pairThreadTurns([
    { id: 'u1', role: 'user', created_at: '2026-07-01T10:00:00Z' },
    { id: 's1', role: 'system', created_at: '2026-07-01T10:00:02Z' },
    { id: 'a1', role: 'assistant', created_at: '2026-07-01T10:00:05Z' }
  ]);
  assert.equal(turns[0].assistantRow.id, 'a1');
});

test('pairThreadTurns orders by created_at, not by input order', () => {
  const turns = pairThreadTurns([
    { id: 'a1', role: 'assistant', created_at: '2026-07-01T10:00:05Z' },
    { id: 'u1', role: 'user', created_at: '2026-07-01T10:00:00Z' }
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].assistantRow.id, 'a1');
});
