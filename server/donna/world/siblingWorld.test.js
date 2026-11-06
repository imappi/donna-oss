import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildExpectedClose } from './oracleSuite.js';
import { deriveSiblingWorld, SIBLING_WORLD_VERSION } from './siblingWorld.js';
import { validateWorldSpec } from './worldSchema.js';
import { validateCausalWorld } from './worldValidity.js';

const fixture = JSON.parse(await readFile('data/worlds/proof0.json', 'utf8'));
const policyPack = JSON.parse(await readFile('data/worlds/policy/gb-uk-ltd-management-books-v1.json', 'utf8'));

test('derives the declared hidden sibling deterministically without mutating its source', () => {
  const source = structuredClone(fixture);
  const before = structuredClone(source);
  const first = deriveSiblingWorld(source);
  const second = deriveSiblingWorld(source);

  assert.equal(first.ok, true, first.errors.join('\n'));
  assert.equal(first.version, SIBLING_WORLD_VERSION);
  assert.deepEqual(first, second);
  assert.deepEqual(source, before);
  assert.equal(first.sourceWorldId, source.worldId);
  assert.equal(first.mutationId, source.counterfactualMutation.id);
  assert.equal(first.declaredFactId, source.counterfactualMutation.declaredFactId);
  assert.equal(first.world.worldId, `${source.worldId}::sibling::${source.counterfactualMutation.id}`);
});

test('changes only the declared fact and derived world identity', () => {
  const result = deriveSiblingWorld(fixture);
  const sourceWithoutIdentity = structuredClone(fixture);
  const siblingWithoutIdentity = structuredClone(result.world);
  delete sourceWithoutIdentity.worldId;
  delete siblingWithoutIdentity.worldId;

  const factId = fixture.counterfactualMutation.declaredFactId;
  const sourceFact = sourceWithoutIdentity.hiddenFacts.find((fact) => fact.id === factId);
  const siblingFact = siblingWithoutIdentity.hiddenFacts.find((fact) => fact.id === factId);
  sourceWithoutIdentity.hiddenFacts = sourceWithoutIdentity.hiddenFacts.filter((fact) => fact.id !== factId);
  siblingWithoutIdentity.hiddenFacts = siblingWithoutIdentity.hiddenFacts.filter((fact) => fact.id !== factId);

  assert.deepEqual(siblingWithoutIdentity, sourceWithoutIdentity);
  assert.deepEqual(siblingFact, { ...sourceFact, ...fixture.counterfactualMutation.replacement });
  assert.equal(siblingFact.value, 'personal holiday');
  assert.equal(siblingFact.expectedTreatment, 'director_loan_account');
});

test('derived Proof 0 sibling passes the merged causal validity gate', () => {
  const result = deriveSiblingWorld(fixture);

  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(validateCausalWorld(result.world), {
    ok: true,
    version: 'proof0.validity.v1',
    errors: [],
  });
});

test('persisted Proof 0 sibling is a treatment-discriminating oracle counterfactual', () => {
  const derived = deriveSiblingWorld(fixture);
  assert.equal(derived.ok, true, derived.errors.join('\n'));

  for (const world of [fixture, derived.world]) {
    assert.deepEqual(validateWorldSpec(world), { ok: true, errors: [] });
    assert.deepEqual(validateCausalWorld(world), {
      ok: true,
      version: 'proof0.validity.v1',
      errors: [],
    });
  }

  const baseProjection = buildExpectedClose(fixture, policyPack);
  const siblingProjection = buildExpectedClose(derived.world, policyPack);
  assert.equal(baseProjection.ok, true, baseProjection.errors.join('\n'));
  assert.equal(siblingProjection.ok, true, siblingProjection.errors.join('\n'));

  const treatmentChange = fixture.counterfactualMutation.expectedTreatmentChange;
  assert.deepEqual(treatmentChange, {
    from: 'travel_expense',
    to: 'director_loan_account',
  });

  const directorEntryId = 'expected-entry/obligation/event/director-charge/purpose-treatment';
  const baseDirectorEntry = baseProjection.expectedEntries.find(({ id }) => id === directorEntryId);
  const siblingDirectorEntry = siblingProjection.expectedEntries.find(({ id }) => id === directorEntryId);
  assert.deepEqual(baseDirectorEntry, {
    id: directorEntryId,
    eventId: 'event/director-charge',
    obligationId: 'obligation/event/director-charge/purpose-treatment',
    treatment: treatmentChange.from,
    accountRole: 'travel_expense',
    amount: 24,
    citationIds: ['hmrc-bim37007-wholly-exclusively'],
  });
  assert.deepEqual(siblingDirectorEntry, {
    ...baseDirectorEntry,
    treatment: treatmentChange.to,
    accountRole: 'director_loan_account',
  });

  assert.deepEqual(siblingProjection, {
    ...baseProjection,
    expectedEntries: baseProjection.expectedEntries.map((entry) => (
      entry.id === directorEntryId ? siblingDirectorEntry : entry
    )),
  });
  assert.notDeepEqual(siblingProjection, baseProjection);
});

test('refuses absent, malformed, empty, multi-fact, and identity-changing declarations', () => {
  const cases = [
    [undefined, /counterfactualMutation must be a declared object/],
    [{ ...fixture.counterfactualMutation, id: '' }, /id must be a non-empty string/],
    [{ ...fixture.counterfactualMutation, replacement: {} }, /replacement must be a non-empty object/],
    [{ ...fixture.counterfactualMutation, changedFactIds: [fixture.counterfactualMutation.declaredFactId, 'hidden/other'] }, /declaredFactId/],
    [{ ...fixture.counterfactualMutation, replacement: { id: 'hidden/renamed' } }, /must not change the declared fact id/],
  ];

  for (const [mutation, expected] of cases) {
    const world = structuredClone(fixture);
    world.counterfactualMutation = mutation;
    const result = deriveSiblingWorld(world);
    assert.equal(result.ok, false);
    assert.equal(result.world, null);
    assert.match(result.errors.join('\n'), expected);
  }
});

test('refuses missing facts and treatment receipts that disagree at either boundary', () => {
  const missingFact = structuredClone(fixture);
  missingFact.counterfactualMutation.declaredFactId = 'hidden/missing';
  missingFact.counterfactualMutation.changedFactIds = ['hidden/missing'];
  assert.match(deriveSiblingWorld(missingFact).errors.join('\n'), /identify exactly one hidden fact/);

  const wrongFrom = structuredClone(fixture);
  wrongFrom.counterfactualMutation.expectedTreatmentChange.from = 'office_expense';
  assert.match(deriveSiblingWorld(wrongFrom).errors.join('\n'), /from must match the source fact treatment/);

  const wrongTo = structuredClone(fixture);
  wrongTo.counterfactualMutation.expectedTreatmentChange.to = 'office_expense';
  assert.match(deriveSiblingWorld(wrongTo).errors.join('\n'), /to must match the replacement treatment/);

  const unchanged = structuredClone(fixture);
  unchanged.counterfactualMutation.replacement.expectedTreatment = 'travel_expense';
  unchanged.counterfactualMutation.expectedTreatmentChange.to = 'travel_expense';
  assert.match(deriveSiblingWorld(unchanged).errors.join('\n'), /treatment-changing replacement/);
});

test('refuses an invalid source rather than deriving around monetary and date boundaries', () => {
  const pennyMismatch = structuredClone(fixture);
  pennyMismatch.events.find(({ id }) => id === 'event/processor-settlement').monetaryEffects.settled = 100.01;
  assert.match(deriveSiblingWorld(pennyMismatch).errors.join('\n'), /sourceWorld.*settled must equal gross/s);

  const earlyReveal = structuredClone(fixture);
  earlyReveal.observations.find(({ id }) => id === 'owner-purpose-answer').observedAt = '2026-08-07';
  assert.match(deriveSiblingWorld(earlyReveal).errors.join('\n'), /sourceWorld.*before revealAfter/s);
});
