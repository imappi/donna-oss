import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeQualifiedArtifactDigest, createQualifiedArtifactReceipt,
  evaluateModelQualification, validateQualifiedArtifactReceipt,
} from './modelQualification.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const NA = Object.freeze({ status: 'not_applicable' });

function artifact(overrides = {}) {
  return {
    provider: 'local-lab', base_model_id: 'model/32b', base_model_digest: A,
    adapter_id: NA, adapter_digest: NA, quantization: 'q4_k_m', runtime: 'llama.cpp',
    runtime_version: 'b6123', vision_projector_digest: NA, tool_protocol_version: 'tools-v2',
    prompt_snapshot_id: 'prompt-9', retrieval_snapshot_id: 'retrieval-4',
    routing_snapshot_id: 'routing-7', hardware_profile: 'metal-m4-32gb',
    execution_mode: 'local_only', model_id_source: 'provider_response',
    network_egress: false, fallback_occurred: false, ...overrides,
  };
}

function inputs() {
  const qualifiedReceipt = createQualifiedArtifactReceipt({
    qualificationId: 'qualification-47', authorityBasis: 'model-release-authority-review',
    modelSource: 'provider_response', modelArtifact: artifact(), solverDigest: B,
    configOverride: { active: false, source: 'none', valueDigest: null },
  });
  return {
    qualifiedReceipt,
    runReceipt: {
      model_source: 'provider_response', model_artifact: artifact(), solverDigest: B,
      configOverride: { active: false, source: 'none', valueDigest: null },
    },
  };
}

function clone(value) { return structuredClone(value); }

test('admits only exact artifact-as-ran parity and returns immutable evidence', () => {
  const pair = inputs();
  const result = evaluateModelQualification(pair);
  assert.deepEqual(result, {
    ok: true, admitted: true, version: 'eaw.model-qualification.v1',
    qualificationId: 'qualification-47', qualifiedReceiptDigest: pair.qualifiedReceipt.receiptDigest,
    demotionReceipt: null,
  });
  assert.equal(Object.isFrozen(pair.qualifiedReceipt), true);
  assert.equal(Object.isFrozen(pair.qualifiedReceipt.modelArtifact), true);
  assert.equal(Object.isFrozen(result), true);
});

const AXES = [
  ['provider', (run) => { run.model_artifact.provider = 'other-provider'; }, 'model_artifact.provider'],
  ['model', (run) => { run.model_artifact.base_model_id = 'model/other'; }, 'model_artifact.base_model_id'],
  ['model digest', (run) => { run.model_artifact.base_model_digest = C; }, 'model_artifact.base_model_digest'],
  ['quantization', (run) => { run.model_artifact.quantization = 'bf16'; }, 'model_artifact.quantization'],
  ['runtime', (run) => { run.model_artifact.runtime_version = 'b7000'; }, 'model_artifact.runtime_version'],
  ['hardware', (run) => { run.model_artifact.hardware_profile = 'cuda-h100'; }, 'model_artifact.hardware_profile'],
  ['mode', (run) => { run.model_artifact.execution_mode = 'hybrid'; run.model_artifact.network_egress = true; }, 'model_artifact.execution_mode'],
  ['config override', (run) => { run.configOverride = { active: true, source: 'OPENAI_MODEL', valueDigest: C }; }, 'configOverride.active'],
  ['solver digest', (run) => { run.solverDigest = C; }, 'solverDigest'],
];

for (const [name, mutate, expectedPath] of AXES) {
  test(`refuses a ${name} mismatch by itself`, () => {
    const pair = inputs();
    const runReceipt = clone(pair.runReceipt);
    mutate(runReceipt);
    const result = evaluateModelQualification({ qualifiedReceipt: pair.qualifiedReceipt, runReceipt });
    assert.equal(result.admitted, false);
    assert.ok(result.demotionReceipt.reasons.includes(`artifact_mismatch:${expectedPath}`), result.demotionReceipt.reasons.join('\n'));
  });
}

test('reports combined mismatches completely, uniquely, and deterministically', () => {
  const pair = inputs();
  const runReceipt = clone(pair.runReceipt);
  for (const [, mutate] of AXES) mutate(runReceipt);
  const first = evaluateModelQualification({ qualifiedReceipt: pair.qualifiedReceipt, runReceipt });
  const second = evaluateModelQualification({ qualifiedReceipt: pair.qualifiedReceipt, runReceipt: clone(runReceipt) });
  assert.equal(first.admitted, false);
  assert.deepEqual(first, second);
  assert.deepEqual(first.demotionReceipt.reasons, [...first.demotionReceipt.reasons].sort());
  assert.equal(new Set(first.demotionReceipt.reasons).size, first.demotionReceipt.reasons.length);
  for (const [, , expectedPath] of AXES) assert.ok(first.demotionReceipt.reasons.includes(`artifact_mismatch:${expectedPath}`), expectedPath);
});

test('refuses configured fallback even when it masquerades as the qualified model id', () => {
  const pair = inputs();
  const runReceipt = clone(pair.runReceipt);
  runReceipt.model_source = 'configured_fallback';
  runReceipt.model_artifact.model_id_source = 'configured_fallback';
  runReceipt.model_artifact.fallback_occurred = true;
  const result = evaluateModelQualification({ qualifiedReceipt: pair.qualifiedReceipt, runReceipt });
  assert.equal(result.admitted, false);
  assert.ok(result.demotionReceipt.reasons.includes('configured_fallback_refused'));
  assert.ok(result.demotionReceipt.reasons.includes('artifact_mismatch:model_source'));
  assert.equal(runReceipt.model_artifact.base_model_id, pair.qualifiedReceipt.modelArtifact.base_model_id);
});

test('refuses every fallback contradiction rather than trusting a configured name', () => {
  for (const mutate of [
    (run) => { run.model_source = 'configured_fallback'; },
    (run) => { run.model_artifact.model_id_source = 'configured_fallback'; },
    (run) => { run.model_artifact.fallback_occurred = true; },
  ]) {
    const pair = inputs(); const runReceipt = clone(pair.runReceipt); mutate(runReceipt);
    const result = evaluateModelQualification({ qualifiedReceipt: pair.qualifiedReceipt, runReceipt });
    assert.equal(result.admitted, false);
    assert.ok(result.demotionReceipt.reasons.includes('configured_fallback_refused'));
  }
});

test('fails closed with deterministic receipts for every missing identity field', () => {
  const missing = [
    ...Object.keys(artifact()).map((field) => ['model_artifact', field]),
    ['root', 'model_source'], ['root', 'solverDigest'],
    ...['active', 'source', 'valueDigest'].map((field) => ['configOverride', field]),
  ];
  for (const [location, field] of missing) {
    const pair = inputs(); const runReceipt = clone(pair.runReceipt);
    if (location === 'model_artifact') delete runReceipt.model_artifact[field];
    else if (location === 'configOverride') delete runReceipt.configOverride[field];
    else delete runReceipt[field];
    const first = evaluateModelQualification({ qualifiedReceipt: pair.qualifiedReceipt, runReceipt });
    const second = evaluateModelQualification({ qualifiedReceipt: pair.qualifiedReceipt, runReceipt: clone(runReceipt) });
    assert.equal(first.admitted, false, `${location}.${field}`);
    assert.deepEqual(first.demotionReceipt, second.demotionReceipt, `${location}.${field}`);
    assert.match(first.demotionReceipt.reasons.join('\n'), new RegExp(field));
  }
});

test('detects every qualified-baseline tamper without silently rewriting its digest', () => {
  const original = inputs().qualifiedReceipt;
  for (const mutate of [
    (receipt) => { receipt.modelArtifact.provider = 'tampered'; },
    (receipt) => { receipt.solverDigest = C; },
    (receipt) => { receipt.configOverride = { active: true, source: 'OPENAI_MODEL', valueDigest: C }; },
    (receipt) => { receipt.qualificationId = 'replacement'; },
  ]) {
    const tampered = clone(original); mutate(tampered);
    assert.equal(tampered.receiptDigest, original.receiptDigest);
    assert.match(validateQualifiedArtifactReceipt(tampered).errors.join('\n'), /does not match canonical/);
    const result = evaluateModelQualification({ qualifiedReceipt: tampered, runReceipt: inputs().runReceipt });
    assert.equal(result.admitted, false);
    assert.match(result.demotionReceipt.reasons.join('\n'), /qualified_invalid:qualified.receiptDigest/);
  }
  assert.equal(computeQualifiedArtifactDigest(original), original.receiptDigest);
});

test('rejects malformed qualified receipts and active overrides without a value digest', () => {
  assert.throws(() => createQualifiedArtifactReceipt({
    qualificationId: 'q', authorityBasis: 'release authority', modelSource: 'configured_fallback',
    modelArtifact: artifact({ model_id_source: 'configured_fallback', fallback_occurred: true }),
    solverDigest: B, configOverride: { active: false, source: 'none', valueDigest: null },
  }), /provider_response/);
  assert.throws(() => createQualifiedArtifactReceipt({
    qualificationId: 'q', authorityBasis: 'release authority', modelSource: 'provider_response',
    modelArtifact: artifact(), solverDigest: B,
    configOverride: { active: true, source: 'OPENAI_MODEL', valueDigest: null },
  }), /valueDigest/);
});
