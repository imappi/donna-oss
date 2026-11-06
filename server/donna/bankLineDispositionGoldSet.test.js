// Q6b — the disposition gold set's DETERMINISTIC half, tested in CI. The
// real-model runner (scripts/run_bank_line_disposition_goldset.js) is never
// CI; these tests pin the scoring, the MUST/SHOULD split, the raw-output
// schema check (incl. the auto_explain ⇒ immaterial contract rule the
// production parser silently launders), the no-ceiling replay design, and
// the threshold gate — so a gate run's verdict is reproducible arithmetic
// over whatever the candidate actually returned.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BANK_LINE_DISPOSITION_GOLD_FIXTURES,
  BANK_LINE_DISPOSITION_GOLD_SET_VERSION,
  BANK_LINE_DISPOSITION_GOLD_THRESHOLDS,
  DISPOSITION_GOLD_MUST_CLASSES,
  DISPOSITION_VOCABULARY,
  bankLineDispositionGoldSetLintErrors,
  meetsBankLineDispositionGoldThresholds,
  scoreBankLineDispositionGoldFixture,
  summarizeBankLineDispositionGoldRun,
  validateDispositionRawOutput
} from './bankLineDispositionGoldSet.js';
import { BANK_LINE_DISPOSITION_POLICY_VERSION } from './bankLineDispositionShape.js';
import { parseDispositionResponse } from './bankLineDispositionLlm.js';

const byId = (id) => BANK_LINE_DISPOSITION_GOLD_FIXTURES.find((f) => f.id === id);

// A well-formed raw candidate reply; overrides per test. `reply` serializes
// it the way a compliant candidate answers (bare JSON).
const rawOutput = (overrides = {}) => ({
  disposition: 'auto_explain',
  materiality: 'immaterial',
  expense_kind: 'software_subscription',
  confidence: 0.8,
  reasoning: 'Small recurring subscription from a recognizable vendor.',
  ...overrides
});
const reply = (overrides = {}) => JSON.stringify(rawOutput(overrides));

await test('the shipped fixture set lints clean, is versioned with the policy contract, and covers both directions', () => {
  assert.deepEqual(bankLineDispositionGoldSetLintErrors(), []);
  assert.ok(BANK_LINE_DISPOSITION_GOLD_SET_VERSION.startsWith(BANK_LINE_DISPOSITION_POLICY_VERSION),
    'a policy-version change must re-baseline the gold set');
  assert.ok(BANK_LINE_DISPOSITION_GOLD_FIXTURES.length >= 15, 'the seed set covers the lane\'s discriminating surface');
  for (const direction of ['money_out', 'money_in']) {
    assert.ok(BANK_LINE_DISPOSITION_GOLD_FIXTURES.some((f) => f.input.direction === direction),
      `the set exercises the ${direction} prompt`);
  }
});

await test('DISPOSITION_VOCABULARY is value-synced with the producer\'s own per-direction sets', () => {
  // Behavioral sync (the producer keeps its sets private on purpose): every
  // vocabulary member survives the lane parser un-collapsed; a foreign
  // disposition collapses to needs_human.
  for (const [direction, vocabulary] of Object.entries(DISPOSITION_VOCABULARY)) {
    for (const disposition of vocabulary) {
      // RT-26: 'statutory_payment' REQUIRES line_identified (a named line);
      // 'needs_human' REQUIRES the opposite. The sync feeds each member the
      // identity claim its own rule demands.
      const parsed = parseDispositionResponse(
        reply({
          disposition,
          materiality: disposition === 'auto_explain' ? 'immaterial' : 'material',
          line_identified: disposition !== 'needs_human'
        }),
        direction
      );
      assert.equal(parsed.disposition, disposition, `${direction}: "${disposition}" is in the producer's vocabulary`);
    }
    const foreign = direction === 'money_out' ? 'chase_evidence' : 'chase_receipt';
    assert.equal(parseDispositionResponse(reply({ disposition: foreign, materiality: 'material' }), direction).disposition,
      'needs_human', `${direction}: "${foreign}" is foreign and collapses`);
  }
});

await test('lint refuses duplicates, foreign vocabulary, whole-vocabulary one_of, and non-discriminating fixtures', () => {
  const bad = [
    { id: 'a', input: { direction: 'money_out', description: 'X', amount: 10 }, expect: { disposition: 'chase_evidence', disposition_one_of: null, materiality: null, min_confidence: null, expense_kind_contains_any: null } },
    { id: 'a', input: { direction: 'money_in', description: 'Y', amount: 10 }, expect: { disposition: null, disposition_one_of: ['auto_explain', 'chase_evidence', 'needs_human'], materiality: null, min_confidence: null, expense_kind_contains_any: null } },
    { id: 'b', input: { direction: 'money_out', description: 'Z', amount: 10 }, expect: { disposition: null, disposition_one_of: null, materiality: 'immaterial', min_confidence: 0.5, expense_kind_contains_any: null } }
  ];
  const errors = bankLineDispositionGoldSetLintErrors(bad);
  assert.ok(errors.some((e) => e.includes('duplicate fixture id')));
  assert.ok(errors.some((e) => e.includes('outside the money_out vocabulary')),
    'chase_evidence is money_in vocabulary — foreign in money_out');
  assert.ok(errors.some((e) => e.includes('spans the whole vocabulary')));
  assert.ok(errors.some((e) => e.includes('no MUST expectation')),
    'materiality:"immaterial" + confidence floors are SHOULD — they must not count as discrimination');
});

await test('raw-output schema validation catches drift and contradiction the production parser silently absorbs', () => {
  assert.deepEqual(validateDispositionRawOutput(rawOutput(), 'money_out'), []);
  assert.ok(validateDispositionRawOutput(null, 'money_out').length > 0);
  assert.ok(validateDispositionRawOutput(rawOutput({ disposition: 'chase_evidence' }), 'money_out').length > 0,
    'a money_in disposition on a money_out line is enum drift even though the parser collapses it to needs_human');
  assert.ok(validateDispositionRawOutput(rawOutput({ disposition: 'auto_explain', materiality: 'material' }), 'money_out')
    .some((e) => e.includes('auto_explain requires materiality')),
    'the prompt\'s own hard rule — the parser launders this to needs_human, only the raw check sees it');
  assert.ok(validateDispositionRawOutput(rawOutput({ confidence: 'high' }), 'money_out').length > 0);
  assert.ok(validateDispositionRawOutput(rawOutput({ expense_kind: 'not snake case!' }), 'money_out').length > 0);
  assert.ok(validateDispositionRawOutput(rawOutput({ reasoning: '  ' }), 'money_out').length > 0,
    'the receipt payload renders reasoning to a reviewer — an empty one is contract drift');
});

await test('a conforming answer passes its fixture on every class; fenced JSON parses like production', () => {
  const score = scoreBankLineDispositionGoldFixture({ text: reply(), fixture: byId('mo_recurring_saas_github') });
  assert.equal(score.pass, true);
  assert.equal(score.must_pass, true);
  assert.deepEqual(score.schema_errors, []);

  const fenced = scoreBankLineDispositionGoldFixture({
    text: '```json\n' + reply() + '\n```',
    fixture: byId('mo_recurring_saas_github')
  });
  assert.equal(fenced.must_pass, true, 'the lane parser tolerates fences, so the gold set does too');
});

await test('both failure directions are verdict MUSTs: wrong auto_explain AND materiality-blind over-asking', () => {
  const overAsking = scoreBankLineDispositionGoldFixture({
    text: reply({ disposition: 'needs_human', materiality: 'immaterial', confidence: 0.4 }),
    fixture: byId('mo_recurring_saas_github')
  });
  assert.equal(overAsking.must_pass, false,
    'needs_human on a textbook recurring sub is the over-asking failure the prompt names — MUST');

  const wrongSettle = scoreBankLineDispositionGoldFixture({
    text: reply({ disposition: 'auto_explain', materiality: 'immaterial', expense_kind: 'groceries' }),
    fixture: byId('mo_groceries_possibly_personal')
  });
  assert.equal(wrongSettle.must_pass, false,
    'auto_explain on a possibly-personal line is the silent-misstatement failure — MUST');
});

await test('the unsafe materiality direction is MUST; the immaterial expectation is calibration (SHOULD)', () => {
  const underFlagged = scoreBankLineDispositionGoldFixture({
    text: reply({ disposition: 'chase_evidence', materiality: 'immaterial', expense_kind: 'processor_payout' }),
    fixture: byId('mi_stripe_payout_material')
  });
  assert.equal(underFlagged.checks.materiality.class, 'materiality');
  assert.equal(underFlagged.must_pass, false, 'a material payout called immaterial is the unsafe direction');

  const immaterialExpectation = scoreBankLineDispositionGoldFixture({
    text: reply(),
    fixture: byId('mo_recurring_saas_github')
  });
  assert.equal(immaterialExpectation.checks.materiality.class, 'calibration',
    'expected-immaterial is priced, not refused');
});

await test('the replay carries NO materiality ceiling — the Keep layer must not do the fixtures\' work', () => {
  // AWS 4800: a candidate that says auto_explain+immaterial is wrong. Under
  // the production ceiling the parser would deterministically downgrade to
  // chase_receipt — which would satisfy the fixture vacuously. The gold set
  // replays ceiling-free, so the model's own verdict is what scores.
  const score = scoreBankLineDispositionGoldFixture({
    text: reply({ disposition: 'auto_explain', materiality: 'immaterial', expense_kind: 'cloud_hosting' }),
    fixture: byId('mo_recurring_but_material_aws')
  });
  assert.equal(score.schema_errors.length, 0, 'auto_explain+immaterial is schema-consistent — the miss is judgment');
  assert.equal(score.checks.disposition_one_of.pass, false,
    'no ceiling downgrade ran: the scored disposition is the model\'s own auto_explain');
  assert.equal(score.must_pass, false);
});

await test('an unparseable or contradictory reply fails every asserted check, honestly', () => {
  const unparseable = scoreBankLineDispositionGoldFixture({ text: 'cannot say', fixture: byId('mi_owner_transfer_ambiguous') });
  assert.equal(unparseable.must_pass, false);
  assert.ok(unparseable.schema_errors.length > 0);
  for (const [, check] of Object.entries(unparseable.checks)) assert.equal(check.pass, false);

  // auto_explain+material on a needs_human fixture: the parser would launder
  // it to needs_human — scoring the laundered value would hand the candidate
  // a verdict it never produced. Schema-invalid ⇒ nothing else scores.
  const contradictory = scoreBankLineDispositionGoldFixture({
    text: reply({ disposition: 'auto_explain', materiality: 'material' }),
    fixture: byId('mi_owner_transfer_ambiguous')
  });
  assert.equal(contradictory.checks.schema_valid.pass, false);
  assert.equal(contradictory.checks.disposition_exact.pass, false,
    'the laundered needs_human must not satisfy the verdict check');
});

await test('summary aggregates MUST regressions by name and the threshold gate is zero-tolerance on them', () => {
  const scored = [
    scoreBankLineDispositionGoldFixture({ text: reply(), fixture: byId('mo_recurring_saas_github') }),
    scoreBankLineDispositionGoldFixture({
      text: reply({ disposition: 'chase_evidence', materiality: 'immaterial', expense_kind: 'processor_payout' }),
      fixture: byId('mi_stripe_payout_material')
    })
  ];
  const summary = summarizeBankLineDispositionGoldRun(scored);
  assert.equal(summary.gold_set_version, BANK_LINE_DISPOSITION_GOLD_SET_VERSION);
  assert.equal(summary.fixtures, 2);
  assert.equal(summary.must_pass_rate, 0.5);
  assert.deepEqual(summary.must_regressions, [{ fixture_id: 'mi_stripe_payout_material', failed: ['materiality'] }]);
  assert.equal(meetsBankLineDispositionGoldThresholds(summary), false,
    'one MUST regression is a red gate, whatever the other rates');

  const clean = summarizeBankLineDispositionGoldRun([
    scoreBankLineDispositionGoldFixture({ text: reply(), fixture: byId('mo_recurring_saas_github') })
  ]);
  assert.equal(clean.must_pass_rate, 1);
  assert.equal(meetsBankLineDispositionGoldThresholds(clean), true);
});

await test('the MUST classes are the three, and every shipped fixture discriminates beyond schema', () => {
  assert.deepEqual([...DISPOSITION_GOLD_MUST_CLASSES].sort(), ['materiality', 'schema', 'verdict']);
  assert.equal(BANK_LINE_DISPOSITION_GOLD_THRESHOLDS.must_pass_rate, 1);
  for (const f of BANK_LINE_DISPOSITION_GOLD_FIXTURES) {
    const exp = f.expect;
    assert.ok(
      exp.disposition !== null || exp.disposition_one_of !== null || exp.materiality === 'material',
      `${f.id}: every fixture discriminates on a MUST class`
    );
  }
});
