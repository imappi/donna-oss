import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';

import {
  digestAeWholePeriod,
  evaluateAeWholePeriodCandidate,
} from '../server/donna/world/aeWholePeriodConvergence.js';
import { runAeWholePeriodConvergence } from './eval_world_ae_whole_period.js';

const WORLD_PATH = new URL('../data/worlds/ae/ae-whole-period-convergence.json', import.meta.url);
const dependencies = Object.freeze({
  databaseConfigured: false,
  objectStoreConfigured: false,
  providerTokenConfigured: false,
});
let run;
let world;

before(async () => {
  world = JSON.parse(await readFile(WORLD_PATH, 'utf8'));
  run = await runAeWholePeriodConvergence({ dependencyStatus: dependencies });
});

test('AE-7 completes the offline certificate and truthfully remains production-incomplete', () => {
  assert.equal(run.status, 'INCOMPLETE');
  assert.equal(run.validation.ok, true);
  assert.equal(run.certificate.offlineStatus, 'PASS');
  assert.deepEqual(run.certificate.failures, []);
  assert.deepEqual(run.certificate.counts, {
    cases: 12,
    obligations: 68,
    t1: 67,
    t2: 1,
    limbo: 0,
    mutations: 19,
    identityCases: 4,
  });
});

test('all twelve shipped AE cases run through their real family evaluators', () => {
  assert.equal(run.candidate.caseReceipts.length, 12);
  assert.ok(run.candidate.caseReceipts.every(({ status }) => ['pass', 'pass_with_named_gaps'].includes(status)));
  assert.equal(new Set(run.candidate.caseReceipts.map(({ family }) => family)).size, 6);
  assert.ok(run.candidate.caseReceipts.every(({ obligationIds }) => obligationIds.length > 0));
});

test('canonical projection leaves no third resting state', () => {
  const projection = run.candidate.terminalProjection;
  assert.equal(projection.projector, 'reconcileConvergenceState');
  assert.equal(projection.items.length, 68);
  assert.equal(projection.items.filter(({ state }) => state === 'auto_reconciled').length, 67);
  assert.equal(projection.items.filter(({ state }) => state === 'on_owner').length, 1);
  assert.equal(projection.items.filter(({ state }) => !['auto_reconciled', 'on_owner'].includes(state)).length, 0);
  assert.equal(projection.digest, digestAeWholePeriod(projection.items));
});

test('T2 is one real named owner ask, not a firm-side placeholder', () => {
  const owner = run.candidate.terminalProjection.items.filter(({ state }) => state === 'on_owner');
  assert.deepEqual(owner, [{
    itemId: 'ae5-cash-commerce/collision/truncated-reference/collision',
    state: 'on_owner',
    reason: 'open_owner_ask',
    responsibleActor: 'owner',
    askId: 'ask/truncated-reference-owner-fact',
  }]);
});

test('the canonical runtime observer agrees with all terminal bytes', () => {
  assert.deepEqual(run.candidate.canonicalObserver.summary, {
    auto_reconciled: 67,
    on_owner: 1,
    hanging: 0,
    total: 68,
    converged: true,
  });
  assert.equal(run.candidate.canonicalObserver.terminalDigest, run.candidate.terminalProjection.digest);
});

test('document, bank, posting, and late-document orders share one terminal digest', () => {
  assert.deepEqual(run.candidate.arrivalReceipts.map(({ orderName }) => orderName), [
    'document_first',
    'bank_first',
    'posting_first',
    'late_document',
  ]);
  assert.equal(new Set(run.candidate.arrivalReceipts.map(({ terminalDigest }) => terminalDigest)).size, 1);
  assert.ok(run.candidate.arrivalReceipts.every(({ familyReceipts }) =>
    familyReceipts.length === 5 && familyReceipts.every(({ converged }) => converged === true)));
});

test('initial, replay, and reset/replay projections are byte-stable', () => {
  assert.deepEqual(run.candidate.replayReceipts.map(({ name }) => name), ['initial', 'replay', 'reset_replay']);
  assert.equal(new Set(run.candidate.replayReceipts.map(({ projectionBytes }) => projectionBytes)).size, 1);
  assert.equal(new Set(run.candidate.replayReceipts.map(({ terminalDigest }) => terminalDigest)).size, 1);
  assert.ok(run.candidate.replayReceipts.every(({ matchesInitial }) => matchesInitial));
});

test('hidden sibling changes exactly one fact and its terminal consequence', () => {
  const sibling = run.candidate.siblingReceipt;
  assert.deepEqual(sibling.changedFactIds, ['hidden/ae7-settlement-identity']);
  assert.equal(sibling.from, 'on_owner');
  assert.equal(sibling.to, 'auto_reconciled');
  assert.equal(sibling.discriminated, true);
  assert.notEqual(sibling.sourceDigest, sibling.siblingDigest);
});

test('every permanent AE mutant refuses at its exact predeclared code', () => {
  const expected = new Map(world.aeWholePeriod.mutationContracts.map(({ id, expectedCode }) => [id, expectedCode]));
  assert.equal(run.candidate.mutationReceipts.length, expected.size);
  for (const receipt of run.candidate.mutationReceipts) {
    assert.equal(receipt.status, 'refused', receipt.id);
    assert.equal(receipt.expectedCode, expected.get(receipt.id), receipt.id);
    assert.equal(receipt.observedCode, expected.get(receipt.id), receipt.id);
    assert.ok(receipt.observedCodes.includes(expected.get(receipt.id)), receipt.id);
  }
});

test('cross-entity, same-name, derived-id, and long-id collisions fail closed', () => {
  assert.deepEqual(run.candidate.identityReceipts.map(({ identityCase }) => identityCase), [
    'cross_entity',
    'same_name',
    'derived_id',
    'long_id',
  ]);
  assert.ok(run.candidate.identityReceipts.every(({ status, code }) =>
    status === 'refused' && code === 'AE_CROSS_ENTITY_LINK'));
});

test('two shrink runs are bounded, deterministic, and preserve consequence', () => {
  const [first, second] = run.candidate.shrinkReceipts;
  assert.equal(first.ok, true);
  assert.equal(first.exhausted, false);
  assert.equal(first.quarantineCount, 0);
  assert.ok(first.removedCount >= 1);
  assert.ok(first.evaluations <= world.aeWholePeriod.shrink.maxEvaluations);
  assert.deepEqual(first, second);
  assert.match(first.targetSignature, /terminal_inventory_changed/);
});

test('shipping VAT and PINT seams pass while retaining real VAT gaps', () => {
  assert.deepEqual(run.candidate.production.vat, {
    status: 'pass_with_named_gaps',
    supportedParity: 'pass',
    gaps: [
      {
        gapId: 'customs_goods_box6_not_consumed_by_production_return',
        documentId: 'document/customs-goods',
        status: 'production_incomplete',
        observedCode: 'AE_VAT_TREATMENT_NOT_ESTABLISHED',
      },
      {
        gapId: 'partial_input_recovery_not_representable_by_posting_code',
        documentId: 'document/residual-purchase',
        status: 'production_incomplete',
        observedCode: 'AE_VAT_CONTROL_ACCOUNT_MISMATCH',
      },
    ],
  });
  assert.equal(run.candidate.production.pint.status, 'pass');
  assert.equal(run.candidate.production.pint.productionParser, 'parsePintAeBillingDocument');
  assert.equal(run.candidate.production.pint.productionRenderer, 'renderCreditNotePdfArtifact');
  assert.equal(run.candidate.production.pint.modelProviderCalls, 0);
});

test('the existing production operation boundary binds without calling writers', () => {
  const binding = run.candidate.production.operationsBinding;
  assert.equal(binding.status, 'bound');
  assert.ok(binding.operations.length > 0);
  assert.equal(binding.writersCalled, 0);
});

test('database-only lifecycle claims are named INCOMPLETE instead of skipped green', () => {
  assert.deepEqual(run.candidate.production.dependencyStatus, dependencies);
  assert.deepEqual(run.certificate.prerequisites.map(({ code, status }) => ({ code, status })), [
    { code: 'AE7_POSTGRESQL_LIFECYCLE_NOT_RUN', status: 'INCOMPLETE' },
    { code: 'AE7_PERSISTED_OBSERVER_NOT_RUN', status: 'INCOMPLETE' },
    { code: 'AE7_CRASH_RESUME_NOT_RUN', status: 'INCOMPLETE' },
    { code: 'AE7_RETIREMENT_CLEANUP_NOT_RUN', status: 'INCOMPLETE' },
  ]);
});

test('offline certificate makes zero model, network, or dollar spend', () => {
  assert.deepEqual(run.candidate.spend, {
    modelProviderCalls: 0,
    externalCalls: 0,
    amountUsd: '0.00',
  });
});

test('a third resting state fails the whole-period certificate', () => {
  const candidate = structuredClone(run.candidate);
  candidate.terminalProjection.items[0].state = 'hanging';
  candidate.terminalProjection.items[0].reason = 'injected_test_limbo';
  candidate.terminalProjection.digest = digestAeWholePeriod(candidate.terminalProjection.items);
  candidate.canonicalObserver.terminalDigest = candidate.terminalProjection.digest;
  const evaluated = evaluateAeWholePeriodCandidate(world, candidate);
  assert.equal(evaluated.status, 'FAIL');
  assert.ok(evaluated.failures.some(({ code }) => code === 'AE7_THIRD_RESTING_STATE'));
});

test('an owner terminal without its named ask fails the certificate', () => {
  const candidate = structuredClone(run.candidate);
  const owner = candidate.terminalProjection.items.find(({ state }) => state === 'on_owner');
  delete owner.askId;
  candidate.terminalProjection.digest = digestAeWholePeriod(candidate.terminalProjection.items);
  candidate.canonicalObserver.terminalDigest = candidate.terminalProjection.digest;
  const evaluated = evaluateAeWholePeriodCandidate(world, candidate);
  assert.equal(evaluated.status, 'FAIL');
  assert.ok(evaluated.failures.some(({ code }) => code === 'AE7_REAL_OWNER_ASK_REQUIRED'));
});

test('a surviving mutation makes the outer mutation suite fail', () => {
  const candidate = structuredClone(run.candidate);
  candidate.mutationReceipts[0].status = 'survived';
  candidate.mutationReceipts[0].observedCode = null;
  const evaluated = evaluateAeWholePeriodCandidate(world, candidate);
  assert.equal(evaluated.status, 'FAIL');
  assert.ok(evaluated.failures.some(({ code }) => code === 'AE7_PROTECTED_MUTATION_SURVIVED'));
});
