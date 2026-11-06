import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  LEARNING_ARTIFACT_SCHEMA_VERSION,
  validateLearningArtifactSchema,
} from './learningArtifactSchema.js';
import { buildObservationSchedule, visibleObservationState } from './observationSchedule.js';
import { buildExpectedClose, evaluateCandidateClose, readProof0PolicyPack } from './oracleSuite.js';
import { validateCausalWorld } from './worldValidity.js';
import { validateWorldSpec } from './worldSchema.js';

function validShape() {
  return {
    version: LEARNING_ARTIFACT_SCHEMA_VERSION,
    caseFamilyId: 'processor-settlement/batched-fx',
    partitionKey: 'family/processor-settlement::counterfactual-group/director-purpose',
    task: {
      taskId: 'next-action/settlement',
      capabilityId: 'reconcile_processor_settlement',
      obligationIds: ['obligation/settlement'],
    },
    visibleState: {
      observations: [{ observationId: 'observation/bank-line', amount: 100 }],
      artifactRefs: ['artifact/bank-line'],
      retrievedMemory: [],
      availableTools: ['propose_match', 'ask_owner'],
      authority: { maximum: 'propose', externalActionPermitted: false },
    },
    admissibleTargets: [
      { actionType: 'propose_match', arguments: { obligationId: 'obligation/settlement' } },
      { actionType: 'block', arguments: { responsibleActor: 'processor' } },
    ],
    hardConstraints: [{
      constraintId: 'constraint/no-untrusted-authority',
      kind: 'authority',
      receiptIds: ['oracle-receipt/proof0'],
    }],
    oracle: {
      oracleVersion: 'proof0.oracleSuite.v1',
      policyPackVersion: 'gb.uk_ltd.management_books.v1',
      receiptIds: ['oracle-receipt/proof0'],
      counterfactualGroupId: 'counterfactual/director-purpose',
    },
    provenance: {
      caseOrigin: 'validated_synthetic_world',
      labelOrigin: 'oracle',
      solverModel: null,
      solverModelRole: 'none',
      vendorOutputCopiedIntoTarget: false,
      containsRealCustomerData: false,
      trainingEligibility: 'eligible',
      evaluationEligibility: 'eligible',
    },
  };
}

function clone(value) { return structuredClone(value); }

test('accepts the complete eaw.learning.v1 shape and an admissible action set', () => {
  assert.deepEqual(validateLearningArtifactSchema(validShape()), {
    ok: true,
    version: LEARNING_ARTIFACT_SCHEMA_VERSION,
    errors: [],
  });
});

test('refuses absent family, partition, task, visible-state, constraint, and oracle receipt shape', () => {
  const cases = [
    ['caseFamilyId', (shape) => { delete shape.caseFamilyId; }],
    ['partitionKey', (shape) => { shape.partitionKey = ''; }],
    ['task.obligationIds', (shape) => { shape.task.obligationIds = []; }],
    ['visibleState.availableTools', (shape) => { delete shape.visibleState.availableTools; }],
    ['hardConstraints', (shape) => { shape.hardConstraints = []; }],
    ['oracle.receiptIds', (shape) => { shape.oracle.receiptIds = []; }],
  ];
  for (const [needle, mutate] of cases) {
    const shape = validShape();
    mutate(shape);
    const result = validateLearningArtifactSchema(shape);
    assert.equal(result.ok, false, needle);
    assert.ok(result.errors.some((error) => error.includes(needle)), `${needle}: ${result.errors.join('; ')}`);
  }
});

test('refuses hidden or privileged truth at any depth of visibleState', () => {
  for (const leak of [
    { hiddenFacts: [{ value: 'customer-site travel' }] },
    { nested: { privilegedTruth: { treatment: 'travel_expense' } } },
    { nested: [{ expectedClose: { entries: [] } }] },
  ]) {
    const shape = validShape();
    shape.visibleState.observations.push(leak);
    const result = validateLearningArtifactSchema(shape);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('must not contain hidden or privileged truth')));
  }
});

test('requires action sets and refuses a single required trajectory representation', () => {
  const trajectory = validShape();
  trajectory.admissibleTargets = undefined;
  trajectory.requiredTrajectory = [{ actionType: 'propose_match' }];
  const result = validateLearningArtifactSchema(trajectory);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('artifact.requiredTrajectory is unsupported'));
  assert.ok(result.errors.includes('admissibleTargets must be a non-empty action set'));

  const singletonSet = validShape();
  singletonSet.admissibleTargets = [singletonSet.admissibleTargets[0]];
  assert.equal(validateLearningArtifactSchema(singletonSet).ok, true, 'one admissible action remains a set, not a coerced trajectory');
});

test('refuses duplicate actions and malformed hard constraints', () => {
  const duplicate = validShape();
  duplicate.admissibleTargets.push(clone(duplicate.admissibleTargets[0]));
  assert.ok(validateLearningArtifactSchema(duplicate).errors.some((error) => error.includes('duplicates another admissible action')));

  const missingReceipt = validShape();
  missingReceipt.hardConstraints[0].receiptIds = [];
  assert.ok(validateLearningArtifactSchema(missingReceipt).errors.some((error) => error.includes('hardConstraints[0].receiptIds')));
});

test('frontier/vendor output and real customer data fail closed for eligibility', () => {
  const frontier = validShape();
  Object.assign(frontier.provenance, {
    labelOrigin: 'frontier_output', solverModel: 'provider-response-model',
    solverModelRole: 'frontier', vendorOutputCopiedIntoTarget: true,
  });
  assert.ok(validateLearningArtifactSchema(frontier).errors.includes('frontier/vendor output is training-ineligible by default'));
  frontier.provenance.trainingEligibility = 'ineligible';
  assert.equal(validateLearningArtifactSchema(frontier).ok, true);

  const customer = validShape();
  customer.provenance.containsRealCustomerData = true;
  const result = validateLearningArtifactSchema(customer);
  assert.ok(result.errors.includes('real customer data is training-ineligible'));
  assert.ok(result.errors.includes('real customer data is evaluation-ineligible in this schema'));
});

test('composes with the full persisted Proof 0 world without copying hidden truth or persisting an artifact', async () => {
  const world = JSON.parse(await readFile('data/worlds/proof0.json', 'utf8'));
  assert.equal(validateWorldSpec(world).ok, true);
  assert.equal(validateCausalWorld(world).ok, true);

  const schedule = buildObservationSchedule(world);
  const visible = visibleObservationState(schedule, '2026-08-08');
  assert.equal(visible.ok, true);
  const policy = await readProof0PolicyPack();
  const expected = buildExpectedClose(world, policy);
  assert.equal(expected.ok, true);
  const candidate = {
    candidateId: 'composition/reference-only',
    entries: expected.expectedEntries.map(({ eventId, accountRole, amount }) => ({ eventId, accountRole, amount })),
    ownerFacts: expected.requiredOwnerFacts.map(({ eventId, requiredFactKind }) => ({ eventId, factKind: requiredFactKind })),
    actions: [],
  };
  const oracleVerdict = evaluateCandidateClose(world, policy, candidate);
  assert.equal(oracleVerdict.errors.length, 0);
  assert.ok(oracleVerdict.receipts.length > 0);

  const shape = validShape();
  shape.task.capabilityId = world.manifest.capabilityId;
  shape.visibleState.observations = visible.observations;
  shape.visibleState.artifactRefs = visible.observations.map(({ artifactId }) => artifactId).filter(Boolean);
  shape.oracle = {
    oracleVersion: oracleVerdict.version,
    policyPackVersion: oracleVerdict.receipts[0].policyPackVersion,
    receiptIds: oracleVerdict.receipts.map(({ id }) => id),
    counterfactualGroupId: world.counterfactualMutation.id,
  };
  shape.hardConstraints[0].receiptIds = [...shape.oracle.receiptIds];

  const serializedVisible = JSON.stringify(shape.visibleState);
  for (const fact of world.hiddenFacts) {
    assert.equal(serializedVisible.includes(JSON.stringify(fact.value)), false, 'hidden value must not cross into visibleState');
    assert.equal(serializedVisible.includes(JSON.stringify(fact.expectedTreatment)), false, 'privileged treatment must not cross into visibleState');
  }
  assert.equal(validateLearningArtifactSchema(shape).ok, true);
});
