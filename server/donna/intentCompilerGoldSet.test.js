// Tests for the intent-compiler gold set (BizOS Slice 1c) — CI covers the FIXTURE LINT and
// the deterministic SCORING only; the real-model runner is scripts/run_intent_compiler_goldset.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GOLD_FIXTURES,
  GOLD_SET_VERSION,
  GOLD_SET_THRESHOLDS,
  goldSetLintErrors,
  scoreCompileResultAgainstFixture,
  summarizeGoldSetRun,
  meetsGoldSetThresholds
} from './intentCompilerGoldSet.js';

const emptyResult = (overrides = {}) => ({
  objects: [], clarification_requests: [], unsupported_spans: [],
  unmet_capability_needs: [], validation_warnings: [], ...overrides
});

test('the gold set lints clean and covers the addendum §8 territories', () => {
  assert.deepEqual(goldSetLintErrors(), []);
  assert.ok(GOLD_FIXTURES.length >= 14);
  const ids = GOLD_FIXTURES.map((f) => f.id);
  // The load-bearing territories, by name — removing one is a deliberate act, not drift.
  for (const required of [
    'birthday_reminder', 'authority_grant_reorder', 'hostile_quoted_instruction',
    'pronoun_resolution', 'ambiguous_two_referents', 'cancellation_supplier',
    'exact_time_reminder', 'task_unsupported_send', 'kill_switch_pause'
  ]) {
    assert.ok(ids.includes(required), `gold set lost fixture "${required}"`);
  }
  // Every one of the nine kinds is demanded (required or any_of) by at least one fixture.
  const demanded = new Set(GOLD_FIXTURES.flatMap((f) => [
    ...f.expectations.required_kinds, ...(f.expectations.any_of_kinds || [])
  ]));
  for (const kind of ['memory', 'preference', 'policy', 'goal', 'commitment', 'task', 'automation', 'workflow', 'authority_grant']) {
    assert.ok(demanded.has(kind), `no fixture demands kind "${kind}"`);
  }
});

test('scoring: a compile matching the birthday expectations passes; a wrong one fails by name', () => {
  const fixture = GOLD_FIXTURES.find((f) => f.id === 'birthday_reminder');
  const good = emptyResult({
    objects: [
      { local_id: 'o1', kind: 'memory', payload: { statement: 's' } },
      { local_id: 'o2', kind: 'commitment', payload: { promise: 'p' } },
      { local_id: 'o3', kind: 'automation', payload: { action_summary: 'a', trigger: { time_spec: { type: 'relative', offset_amount: 18, offset_unit: 'hours', anchor: 'o1' } } } }
    ]
  });
  const scored = scoreCompileResultAgainstFixture(good, fixture);
  assert.equal(scored.pass, true);

  const missingCommitment = emptyResult({ objects: good.objects.filter((o) => o.kind !== 'commitment') });
  const failed = scoreCompileResultAgainstFixture(missingCommitment, fixture);
  assert.equal(failed.pass, false);
  assert.equal(failed.checks.required_kinds, false);
});

test('scoring: forbidden kinds, unmet needs, clarification and time-shape checks fire', () => {
  const hostile = GOLD_FIXTURES.find((f) => f.id === 'hostile_quoted_instruction');
  const poisoned = emptyResult({ objects: [{ local_id: 'g1', kind: 'authority_grant', payload: { requested_scope: 'pay' } }] });
  assert.equal(scoreCompileResultAgainstFixture(poisoned, hostile).checks.forbidden_kinds, false);
  assert.equal(scoreCompileResultAgainstFixture(emptyResult(), hostile).pass, true);

  const unsupported = GOLD_FIXTURES.find((f) => f.id === 'task_unsupported_send');
  const noNeed = emptyResult({ objects: [{ local_id: 't1', kind: 'task', payload: { outcome: 'x' } }] });
  assert.equal(scoreCompileResultAgainstFixture(noNeed, unsupported).checks.unmet_recorded, false);

  const ambiguous = GOLD_FIXTURES.find((f) => f.id === 'ambiguous_two_referents');
  assert.equal(scoreCompileResultAgainstFixture(emptyResult(), ambiguous).checks.clarification, false);
  assert.equal(
    scoreCompileResultAgainstFixture(
      emptyResult({ clarification_requests: [{ question: 'the reminder or the email?', affected_local_ids: [] }] }),
      ambiguous
    ).checks.clarification,
    true
  );

  const exact = GOLD_FIXTURES.find((f) => f.id === 'exact_time_reminder');
  const relativeOnly = emptyResult({
    objects: [{ local_id: 'a1', kind: 'automation', payload: { action_summary: 'r', trigger: { time_spec: { type: 'relative', offset_amount: 1, offset_unit: 'days', anchor: 'x' } } } }]
  });
  assert.equal(scoreCompileResultAgainstFixture(relativeOnly, exact).checks.time_shape, false);
});

test('summary metrics + thresholds gate as specified', () => {
  const allPass = GOLD_FIXTURES.map((f) => ({
    fixture_id: f.id,
    checks: {
      schema_valid: true, required_kinds: true, any_of_kinds: true, forbidden_kinds: true,
      min_objects: true, unmet_recorded: true, clarification: true, time_shape: true,
      no_validation_warnings: true
    },
    pass: true
  }));
  const summary = summarizeGoldSetRun(allPass);
  assert.equal(summary.gold_set_version, GOLD_SET_VERSION);
  assert.equal(summary.pass_rate, 1);
  assert.equal(meetsGoldSetThresholds(summary), true);

  const oneSchemaFail = allPass.map((s, i) => (i < 2
    ? { ...s, pass: false, checks: { ...s.checks, schema_valid: false } }
    : s));
  const failing = summarizeGoldSetRun(oneSchemaFail);
  assert.ok(failing.schema_valid_rate < GOLD_SET_THRESHOLDS.schema_valid_rate);
  assert.equal(meetsGoldSetThresholds(failing), false);
});
