import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateAskSequence } from './askContract.js';
import { ASK_CLASSES, classifyAskPolicy, evaluateAskPolicy } from './askPolicy.js';
import { buildObservationSchedule } from './observationSchedule.js';
import { projectPolicy } from './policyProjection.js';

const worldUrl = new URL('../../../data/worlds/slice1-director-purpose-close.json', import.meta.url);
const policyUrl = new URL('../../../data/worlds/policy/gb-uk-ltd-management-books-v1.json', import.meta.url);

async function fixture() {
  const world = JSON.parse(await readFile(worldUrl, 'utf8'));
  const pack = JSON.parse(await readFile(policyUrl, 'utf8'));
  const projection = projectPolicy(world, pack);
  const purpose = world.hiddenFacts[0];
  purpose.askPolicy = { changesTreatment: true };
  world.hiddenFacts.push(
    { id: 'fact/optional-note', kind: 'optional_note', value: 'secret optional', askPolicy: { changesTreatment: true } },
    { id: 'fact/later-confirmation', kind: 'later_confirmation', value: 'secret later', askPolicy: { changesAuthority: true, obligationDeadline: '2026-08-20', askBy: '2026-08-20' } },
    { id: 'fact/irrelevant-colour', kind: 'irrelevant_colour', value: 'secret blue', askPolicy: {} },
    { id: 'fact/known-code', kind: 'known_code', value: 'secret known', askPolicy: { changesAuthority: true } },
  );
  projection.obligations.find((item) => item.requiredFactKind === 'business_purpose').id = 'obligation/director-charge';
  return { world, projection };
}

function classify(world, projection) {
  return classifyAskPolicy({
    world, projection, asOf: '2026-08-10',
    authorityState: { knownFactClasses: ['known_code'], requiredFactClasses: ['later_confirmation'] },
    obligationDeadlines: { 'obligation/director-charge': '2026-08-10' },
    safeFallbacks: { optional_note: { safe: true, reversible: true, path: 'provisional_classification' } },
  });
}

test('full merged Slice 1 family deterministically covers every ordinal class from truth inputs', async () => {
  const { world, projection } = await fixture();
  const report = classify(world, projection);
  assert.equal(report.ok, true, report.errors.join('\n'));
  assert.deepEqual([...new Set(report.classifications.map((item) => item.class))].sort(), [...ASK_CLASSES].sort());
  assert.equal(report.classifications.find((item) => item.fact_class === 'business_purpose').class, 'ASK_REQUIRED');
  assert.equal(report.classifications.find((item) => item.fact_class === 'optional_note').class, 'ASK_OPTIONAL');
  assert.deepEqual(report.classifications.find((item) => item.fact_class === 'later_confirmation'), {
    fact_class: 'later_confirmation', class: 'DEFER', reason: 'fact_matters_after_current_obligation', affected_obligations: [], ask_by: '2026-08-20',
  });
  assert.equal(report.classifications.find((item) => item.fact_class === 'irrelevant_colour').class, 'DO_NOT_ASK');
  assert.equal(report.classifications.find((item) => item.fact_class === 'known_code').reason, 'fact_already_known');
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('DEFER uses the obligation deadline as its deterministic ask-by oracle expectation', async () => {
  const { world, projection } = await fixture();
  const deferred = world.hiddenFacts.find((item) => item.kind === 'later_confirmation').askPolicy;
  deferred.askBy = undefined;
  const report = classify(world, projection);
  assert.equal(report.ok, true);
  assert.equal(report.classifications.find((item) => item.fact_class === 'later_confirmation').ask_by, '2026-08-20');
});

test('realistic ask sequence proves over-ask and under-ask verdicts both ways with Unit 55', async () => {
  const { world, projection } = await fixture();
  const policy = classify(world, projection);
  const purpose = world.hiddenFacts.find((item) => item.kind === 'business_purpose');
  purpose.askEvaluation = { affectedObligations: ['obligation/director-charge'], outcomesRemainDistinct: true, distinguishing: true, answerSufficient: true, requiredFactClasses: ['business_purpose'], neededAt: '2026-08-10' };
  const requiredAsk = { version: 'eaw.ask.v1', ask_id: 'ask/purpose', case_id: 'case/director', fact_class: 'business_purpose', affected_obligations: ['obligation/director-charge'], remaining_hypotheses: ['business', 'personal'], evidence_already_checked: [], expected_answer_type: 'owner_fact', reliability_required: 'owner_attested', next_state_if_answered: 'ready_to_post', deferrable_until: null, bundle_id: null };
  const builtSchedule = buildObservationSchedule(world);
  const schedule = { ...builtSchedule, observations: builtSchedule.observations.filter((receipt) => receipt.observationId !== 'owner-purpose-answer') };
  const answers = [{ ask_id: 'ask/purpose', fact_class: 'business_purpose', answered_at: '2026-08-11' }];
  const transitions = [{ case_id: 'case/director', at: '2026-08-12', state: 'ready_to_post' }];
  const pass = evaluateAskPolicy({ policy, world, schedule, asks: [{ record: requiredAsk, asked_at: '2026-08-10' }], answers, transitions, actions: [{ action_id: 'post/after-answer', affected_obligations: ['obligation/director-charge'] }] });
  assert.equal(pass.askEvaluation.ok, true, JSON.stringify(pass.askEvaluation));
  assert.deepEqual(pass.overAsk, []); assert.deepEqual(pass.underAsk, []); assert.equal(pass.ok, true);

  const doNotAsk = { ...requiredAsk, ask_id: 'ask/colour', fact_class: 'irrelevant_colour' };
  const fail = evaluateAskPolicy({ policy, world, schedule, asks: [{ record: doNotAsk, asked_at: '2026-08-10' }], actions: [{ action_id: 'post/too-soon', affected_obligations: ['obligation/director-charge'] }] });
  assert.equal(fail.overAsk[0].reason, 'asked_do_not_ask_fact');
  assert.equal(fail.underAsk[0].reason, 'acted_while_required_fact_unanswered');
  assert.equal(fail.ok, false);
});

test('already-known ask is over-asking and a required unanswered fact is harmless until action', async () => {
  const { world, projection } = await fixture(); const policy = classify(world, projection);
  const knownAsk = { record: { ask_id: 'ask/known', fact_class: 'known_code' } };
  const over = evaluateAskPolicy({ policy, asks: [knownAsk] });
  assert.equal(over.overAsk[0].reason, 'asked_already_known_fact');
  const noAction = evaluateAskPolicy({ policy });
  assert.deepEqual(noAction.underAsk, []);
});
