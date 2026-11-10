// Tests for the pure halves of seat_qwen_sole_model.js — the plan builder's
// three-way split (seats / refused / outside-the-feed) and argv parsing.
// No DB: importing the script module never connects (invokedDirectly guard).

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSoleModelSeatPlan, parseArgv } from './seat_qwen_sole_model.js';
import { MODEL_LANES } from '../server/donna/modelLanes.js';

test('the qwen plan seats exactly the lanes whose qualified set carries the cloud 27B', () => {
  const plan = buildSoleModelSeatPlan({ model: 'qwen/qwen3.8-27b' });
  // The Q7/Q6c/Q9 seats, in registry order.
  assert.deepEqual(plan.seats, ['reconciliation_reasoning', 'transaction_coding', 'bank_line_disposition']);
  assert.ok(plan.ok);
  // A governed lane that does NOT qualify the model is refused, never forced
  // (the store would throw MODEL_NOT_QUALIFIED; the plan says so up front).
  // RT-12: the unified extraction lane is governed (its two providers'
  // strong defaults) and does not qualify the 27B — skipped loudly, never
  // forced. (bank_line_classification, the first such skip, was retired in
  // RT-14.)
  assert.ok(plan.skipped.some((s) => s.laneId === 'unified_extraction'));
  // Ungoverned lanes are the remaining sole-model bug surface, listed honestly.
  // (bank_statement_vision and document_chat joined the feed with the
  // document and text lanes, 2026-11-10.)
  assert.ok(plan.skipped.some((s) => s.laneId === 'bank_statement_vision'));
  assert.ok(plan.ungoverned.includes('merchant_lookup'));
  assert.ok(plan.ungoverned.includes('chat_engine'));
  // The split is a partition of the registry.
  assert.equal(
    plan.seats.length + plan.skipped.length + plan.ungoverned.length,
    MODEL_LANES.length
  );
});

test('a model qualified nowhere yields a refusing plan', () => {
  // (gpt-5.4-nano is qualified on receipt_classification as its OpenAI
  // alternative since 2026-11-10; gpt-5.4-mini is qualified nowhere.)
  const plan = buildSoleModelSeatPlan({ model: 'gpt-5.4-mini' });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.seats, []);
});

test('argv: dry-run by default; firm/model/apply parse', () => {
  assert.equal(parseArgv([]).apply, false);
  assert.equal(parseArgv([]).model, 'qwen/qwen3.8-27b');
  assert.equal(parseArgv([]).firmId, 'donna-demo-firm');
  const parsed = parseArgv(['--firm', 'donna-production', '--model', 'claude-opus-4-8', '--apply']);
  assert.equal(parsed.firmId, 'donna-production');
  assert.equal(parsed.model, 'claude-opus-4-8');
  assert.equal(parsed.apply, true);
});
