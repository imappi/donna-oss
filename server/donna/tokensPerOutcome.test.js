// tokens_per_outcome — the read surface, pinned.
//
// These are SQL-shape and contract tests on a mock client, in the house style
// for this tree's read modules: they pin the parameterisation, the scoping, the
// join key, and the coverage arithmetic. What they cannot do is execute
// Postgres, so anything asserted about aggregation semantics is asserted about
// the STATEMENT, not about a result set.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  tokensPerOutcome, executionSpend, laneSpend, KNOWN_UNINSTRUMENTED_LANES
} from './tokensPerOutcome.js';

const mockClient = (rows = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return { rows, rowCount: rows.length };
    }
  };
};

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

test('tokensPerOutcome groups by the OUTCOME and breaks out retry cost', async () => {
  const client = mockClient();
  await tokensPerOutcome(client, { firmId: 'f1', now: NOW });
  const { sql, params } = client.calls[0];

  assert.match(sql, /group by decision_type, final_state, lane/);
  // final_state is the outcome the tokens were spent reaching — the whole point
  // of writing the receipt at the resting state rather than at the read.
  assert.match(sql, /avg_tokens_per_outcome/);
  // G3's third unanswerable question. An average that blends retried and
  // first-try calls answers it wrongly rather than not at all.
  assert.match(sql, /filter \(where attempt_count > 1\)/);
  assert.equal(params[0], new Date(NOW - 30 * 86400000).toISOString());
  assert.equal(params[1], 'f1');
  assert.equal(params[2], null);
});

test('the normalized usage keys are read, never the raw provider blob', async () => {
  const client = mockClient();
  await tokensPerOutcome(client, { now: NOW });
  const { sql } = client.calls[0];
  assert.match(sql, /usage->>'input_tokens'/);
  assert.match(sql, /usage->>'output_tokens'/);
  // provider_usage is kept to DIAGNOSE a normalization bug. Reading it here
  // would launder that bug into the metric it was kept to expose.
  assert.ok(!sql.includes('provider_usage'), 'the raw provider blob is not a metric source');
});

test('scoping is parameterised, never interpolated', async () => {
  for (const [args, expected] of [
    [{ firmId: 'f1', clientId: 'c1' }, ['f1', 'c1']],
    [{}, [null, null]]
  ]) {
    const client = mockClient();
    await tokensPerOutcome(client, { ...args, now: NOW });
    const { sql, params } = client.calls[0];
    assert.deepEqual([params[1], params[2]], expected);
    assert.ok(!sql.includes("'f1'"), 'no interpolated identifiers');
  }
});

test('the window is a whole positive number of days, with a sane fallback', async () => {
  for (const [windowDays, days] of [[7, 7], [1.9, 1], [0, 30], [-5, 30], [null, 30], ['x', 30]]) {
    const client = mockClient();
    await tokensPerOutcome(client, { windowDays, now: NOW });
    assert.equal(
      client.calls[0].params[0],
      new Date(NOW - days * 86400000).toISOString(),
      `windowDays=${windowDays}`
    );
  }
});

test('executionSpend joins on the TYPED ref — the reason 106 refused a nullable union', async () => {
  const client = mockClient();
  await executionSpend(client, {
    rootExecutionType: 'owner_invoice_command_message', rootExecutionId: 'wamid.abc', now: NOW
  });
  const { sql, params } = client.calls[0];

  // Grouped by the PAIR. An identity spread across four nullable columns cannot
  // be grouped on at all, which is exactly what S1's stale spec proposed.
  assert.match(sql, /group by root_execution_type, root_execution_id/);
  // Matches the partial index `idx_llm_decisions_root_execution`.
  assert.match(sql, /root_execution_id is not null/);
  // G3's second unanswerable question: a task with three model calls has three
  // receipts under one root.
  assert.match(sql, /count\(\*\)::int\s+as calls/);
  assert.equal(params[1], 'owner_invoice_command_message');
  assert.equal(params[2], 'wamid.abc');
});

test('executionSpend bounds its own result set, and the bound is never zero or NaN', async () => {
  for (const [limit, expected] of [[10, 10], [0, 100], [-1, 1], [undefined, 100], ['x', 100]]) {
    const client = mockClient();
    await executionSpend(client, { limit, now: NOW });
    assert.equal(client.calls[0].params[4], expected, `limit=${limit}`);
  }
});

test('laneSpend reports COVERAGE alongside the ranking, never bare numbers', async () => {
  const client = mockClient([
    { lane: 'owner_invoice_command', decisions: 40, instrumented: 40, total_tokens: '52000', model_ids: 1 },
    { lane: 'match', decisions: 60, instrumented: 0, total_tokens: '0', model_ids: 1 }
  ]);
  const out = await laneSpend(client, { firmId: 'f1', now: NOW });

  assert.equal(out.lanes.length, 2);
  assert.equal(out.coverage.decisions, 100);
  assert.equal(out.coverage.instrumented, 40);
  assert.equal(out.coverage.instrumentedShare, 0.4);
  // A lane absent from the ranking is not a lane that spends nothing — it is a
  // lane not yet on the envelope, and the two are indistinguishable from the
  // numbers alone. Naming the known one is the no-silent-caps rail.
  assert.deepEqual(out.coverage.knownUninstrumentedLanes, KNOWN_UNINSTRUMENTED_LANES);
});

test('an empty window reports a NULL share, not a confident zero', async () => {
  const out = await laneSpend(mockClient([]), { now: NOW });
  // "no receipts at all" and "receipts that all lack telemetry" are different
  // facts. A 0 would make the first look like the second.
  assert.equal(out.coverage.instrumentedShare, null);
  assert.equal(out.coverage.decisions, 0);
  assert.deepEqual(out.lanes, []);
});

test('the known-exclusion list is frozen, and names the intent compiler with its receipt home', () => {
  assert.ok(Object.isFrozen(KNOWN_UNINSTRUMENTED_LANES));
  const compiler = KNOWN_UNINSTRUMENTED_LANES.find((l) => l.lane === 'intent_compiler');
  assert.ok(compiler, 'the one lane we already know is off these columns is named');
  assert.equal(compiler.receiptHome, 'client_chat_messages.payload->intent_compile');
  assert.equal(compiler.joinKey, 'source_message_id');
});

test('the read surface is READ-ONLY — no mutation reaches the database', async () => {
  const client = mockClient();
  await tokensPerOutcome(client, { now: NOW });
  await executionSpend(client, { now: NOW });
  await laneSpend(client, { now: NOW });
  assert.equal(client.calls.length, 3);
  for (const { sql } of client.calls) {
    assert.doesNotMatch(sql, /\b(insert|update|delete|alter|drop|truncate)\b/i,
      'a measurement surface that mutates is not a measurement surface');
  }
});
