import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildObservationSchedule } from './observationSchedule.js';
import { ASK_CHECKS, ASK_CONTRACT_VERSION, evaluateAskSequence, normalizeEvidenceRequestRead, validateAskRecord } from './askContract.js';

const fixtureUrl = new URL('../../../data/worlds/slice1-director-purpose-close.json', import.meta.url);

function record(overrides = {}) {
  return {
    version: ASK_CONTRACT_VERSION,
    ask_id: 'ask/purpose', case_id: 'case/director-charge', fact_class: 'business_purpose',
    affected_obligations: ['obligation/director-charge'],
    remaining_hypotheses: ['business', 'personal'],
    evidence_already_checked: ['artifact/director-card-line', 'artifact/director-receipt'],
    expected_answer_type: 'owner_fact_value', reliability_required: 'owner_attested',
    next_state_if_answered: 'ready_to_post', deferrable_until: '2026-08-07', bundle_id: 'bundle/director',
    ...overrides,
  };
}

async function familyWorld() {
  const world = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  world.hiddenFacts[0].askEvaluation = {
    affectedObligations: ['obligation/director-charge'], outcomesRemainDistinct: true,
    distinguishing: true, answerSufficient: true, expectedAnswerType: 'owner_fact_value',
    reliabilityRequired: 'owner_attested', requiredFactClasses: ['business_purpose'],
    requiredEvidence: ['artifact/director-card-line', 'artifact/director-receipt'],
    bundleGroup: 'director-close', neededAt: '2026-08-07',
  };
  return world;
}

function run(world, ask = record(), options = {}) {
  const schedule = buildObservationSchedule(world);
  return evaluateAskSequence({
    world, schedule,
    asks: [{ record: ask, asked_at: options.askedAt ?? '2026-08-07' }, ...(options.extraAsks ?? [])],
    answers: options.answers ?? [{ ask_id: ask.ask_id, fact_class: ask.fact_class, answered_at: '2026-08-08' }],
    transitions: options.transitions ?? [{ case_id: ask.case_id, at: '2026-08-09', state: ask.next_state_if_answered }],
  });
}

function failName(report, name) { assert.equal(report.verdicts[0].checks[name].pass, false, JSON.stringify(report.verdicts[0].checks)); }

test('validates the complete eaw.ask.v1 record and rejects additions', () => {
  assert.equal(validateAskRecord(record()).ok, true);
  assert.match(validateAskRecord(record({ prose_grade: 0.91 })).errors.join('\n'), /unsupported field/);
});

test('normalizes the Unit 39 counts/requests production read shape as data', () => {
  const normalized = normalizeEvidenceRequestRead({ counts: { open: 1 }, requests: [{ status: 'open', created_at: '2026-08-07', ask_contract: record() }] });
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.asks[0], { record: record(), asked_at: '2026-08-07', status: 'open', answered_at: null });
});

test('full Slice 1 family composition passes all nine structural checks through schedule and reader normalization', async () => {
  const world = await familyWorld();
  const read = normalizeEvidenceRequestRead({ counts: { open: 1 }, requests: [{ status: 'replied', created_at: '2026-08-07', replied_at: '2026-08-08', payload: { ask_contract: record() } }] });
  const report = evaluateAskSequence({ world, schedule: buildObservationSchedule(world), asks: read.asks, answers: [{ ask_id: 'ask/purpose', fact_class: 'business_purpose', answered_at: '2026-08-08' }], transitions: [{ case_id: 'case/director-charge', at: '2026-08-09', state: 'ready_to_post' }] });
  assert.equal(report.ok, true);
  for (const name of ASK_CHECKS) assert.deepEqual(report.summary[name], { passed: 1, failed: 0 });
});

test('necessity fails when privileged truth says outcomes no longer differ', async () => { const w = await familyWorld(); w.hiddenFacts[0].askEvaluation.outcomesRemainDistinct = false; failName(run(w), 'necessity'); });
test('relevance fails for a non-distinguishing fact', async () => { const w = await familyWorld(); w.hiddenFacts[0].askEvaluation.distinguishing = false; failName(run(w), 'relevance'); });
test('sufficiency fails when the reliable answer cannot permit the next action', async () => { const w = await familyWorld(); w.hiddenFacts[0].askEvaluation.answerSufficient = false; failName(run(w), 'sufficiency'); });
test('minimality fails when required checked evidence is omitted', async () => { const w = await familyWorld(); failName(run(w, record({ evidence_already_checked: ['artifact/director-card-line'] })), 'minimality'); });
test('non-redundancy fails a re-ask of an already answered fact', async () => { const w = await familyWorld(); const report = run(w, record(), { answers: [{ ask_id: 'old/ask', fact_class: 'business_purpose', answered_at: '2026-08-06' }] }); failName(report, 'non_redundancy'); });
test('bundling fails when a related ask has no bundle id', async () => { const w = await familyWorld(); failName(run(w, record({ bundle_id: null })), 'bundling'); });
test('timing fails before the fact is needed', async () => { const w = await familyWorld(); failName(run(w, record(), { askedAt: '2026-08-06' }), 'timing'); });
test('resumption fails when an answered case does not continue', async () => { const w = await familyWorld(); failName(run(w, record(), { transitions: [] }), 'resumption'); });
test('contradiction handling fails unless later contradictory evidence reopens', async () => { const w = await familyWorld(); w.observations.push({ id: 'purpose-contradiction', observedAt: '2026-08-10', contradictsFactClass: 'business_purpose' }); failName(run(w), 'contradiction_handling'); });

test('contradiction handling passes with an explicit later reopen', async () => {
  const w = await familyWorld(); w.observations.push({ id: 'purpose-contradiction', observedAt: '2026-08-10', contradictsFactClass: 'business_purpose' });
  const report = run(w, record(), { transitions: [{ case_id: 'case/director-charge', at: '2026-08-09', state: 'ready_to_post' }, { case_id: 'case/director-charge', at: '2026-08-10', state: 'reopened' }] });
  assert.equal(report.verdicts[0].checks.contradiction_handling.pass, true);
});

test('evaluator reports never leak privileged hidden values', async () => {
  const w = await familyWorld(); const secret = w.hiddenFacts[0].value;
  const report = run(w, record(), { transitions: [] });
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(JSON.stringify(report).includes('expectedTreatment'), false);
});
