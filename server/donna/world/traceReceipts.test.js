import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { applyFeeAsRevenueMutation } from './oracleMutations.js';
import { buildExpectedClose, evaluateCandidateClose, readProof0PolicyPack } from './oracleSuite.js';
import { buildFailureReceipt, classifyModelProvenance, createDecisionReceipt, findEarliestObservableDivergence, LEGACY_TRACE_RECEIPTS_VERSION, MODEL_PROVENANCE_CLASSIFICATIONS, TRACE_RECEIPTS_VERSION, validateDecisionReceipt } from './traceReceipts.js';
import { createProof0WorldSpec } from './worldSchema.js';

function world() {
  return createProof0WorldSpec({
    worldId: 'proof0/trace-processor-settlement',
    seed: 'proof0-trace-001',
    effectiveDate: '2026-08-05',
    entities: [
      { id: 'entity/client', kind: 'legal_entity', activeFrom: '2026-01-01' },
      { id: 'entity/customer', kind: 'counterparty', activeFrom: '2026-01-01' },
    ],
    events: [{
      id: 'event/processor-settlement',
      type: 'processor_settlement',
      legalEntityId: 'entity/client',
      occurredAt: '2026-08-05',
      causalParents: [],
      monetaryEffects: { grossReceipts: 102.35, fees: 3.15, refunds: 0, reserves: 0, chargebacks: 0, fxGainLoss: 0.8, settled: 100, currency: 'GBP' },
      evidenceRefs: ['artifact/processor-report'],
    }],
    observations: [{ id: 'observation/processor-report', eventId: 'event/processor-settlement', artifactId: 'artifact/processor-report', observedAt: '2026-08-06' }],
    hiddenFacts: [],
    artifacts: [{ id: 'artifact/processor-report', kind: 'processor_report', trusted: true }],
  });
}

function receipt(overrides = {}) {
  return createDecisionReceipt({
    decisionId: 'decision/fee-treatment',
    worldId: 'proof0/trace-processor-settlement',
    capabilityId: 'reconcile_processor_settlement',
    stage: 'tool_calls_and_arithmetic',
    selectedAction: 'classify_processor_fee',
    authorityBasis: 'management_books_policy_projection',
    sourceTrust: 'trusted_processor_report',
    reversibility: 'reversible_offline_eval',
    externalConsequence: 'ledger_close_candidate',
    nextState: 'fee_classified_as_revenue',
    modelId: 'response-model-id-from-runner',
    expectedState: 'processor_fee_expense',
    observedState: 'sales_revenue',
    confidence: 'high',
    oracleFailureIds: ['processor_fees_expense'],
    ...overrides,
  });
}

const na = () => ({ status: 'not_applicable' });
const unknown = (reason) => ({ status: 'unknown', reason });
const digest = (character) => character.repeat(64);

function frontierArtifact(overrides = {}) {
  return {
    provider: 'frontier-provider',
    base_model_id: 'response-model-id-from-runner',
    base_model_digest: unknown('provider does not publish an artifact digest'),
    adapter_id: na(),
    adapter_digest: na(),
    quantization: unknown('provider does not disclose serving quantization'),
    runtime: 'provider-managed',
    runtime_version: unknown('provider does not disclose runtime version'),
    vision_projector_digest: na(),
    tool_protocol_version: 'tools.v1',
    prompt_snapshot_id: 'prompt/proof0/v1',
    retrieval_snapshot_id: na(),
    routing_snapshot_id: 'routing/proof0/v1',
    hardware_profile: unknown('provider-managed hardware is undisclosed'),
    execution_mode: 'frontier',
    model_id_source: 'provider_response',
    network_egress: true,
    fallback_occurred: false,
    ...overrides,
  };
}

function localArtifact(overrides = {}) {
  return {
    provider: 'local-runtime',
    base_model_id: 'local/base-32b',
    base_model_digest: digest('a'),
    adapter_id: 'adapter/bookkeeping-v1',
    adapter_digest: digest('b'),
    quantization: 'Q4_K_M',
    runtime: 'llama.cpp',
    runtime_version: 'b6100',
    vision_projector_digest: na(),
    tool_protocol_version: 'tools.v1',
    prompt_snapshot_id: 'prompt/proof0/v1',
    retrieval_snapshot_id: 'retrieval/proof0/v1',
    routing_snapshot_id: 'routing/local-only/v1',
    hardware_profile: 'gpu/24gb-sm_89',
    execution_mode: 'local_only',
    model_id_source: 'provider_response',
    network_egress: false,
    fallback_occurred: false,
    ...overrides,
  };
}

test('decision receipts require resolved model id and observable stage', () => {
  assert.deepEqual(validateDecisionReceipt(receipt()), {
    ok: true,
    version: TRACE_RECEIPTS_VERSION,
    provenance: {
      classification: MODEL_PROVENANCE_CLASSIFICATIONS.LEGACY_UNPROVEN,
      reason: 'legacy receipt has a model id but no response or artifact provenance',
    },
    errors: [],
  });

  assert.deepEqual(validateDecisionReceipt(receipt({ modelId: '', stage: 'private_chain_of_thought' })).errors, [
    'modelId must be a non-empty string',
    'stage must be one of observed_evidence, extracted_structured_state, retrieved_context_and_memory, candidate_state_alternatives, tool_calls_and_arithmetic, policy_references, uncertainty_branch, authority_decision, owner_ask_and_response, posting_reconciliation_or_blocked_obligation, final_close_and_external_state',
  ]);
});

test('provenance receipts use v2 while unchanged historical receipts remain v1', () => {
  const legacy = receipt();
  assert.equal(legacy.receiptVersion, LEGACY_TRACE_RECEIPTS_VERSION);
  assert.equal(validateDecisionReceipt(legacy).ok, true);

  const current = receipt({ model_source: 'provider_response', model_artifact: frontierArtifact() });
  assert.equal(current.receiptVersion, TRACE_RECEIPTS_VERSION);
  assert.equal(validateDecisionReceipt(current).ok, true);

  assert.equal(validateDecisionReceipt({ ...legacy, receiptVersion: TRACE_RECEIPTS_VERSION }).ok, false);
  assert.equal(validateDecisionReceipt({ ...current, receiptVersion: LEGACY_TRACE_RECEIPTS_VERSION }).ok, false);
});

test('merged Proof-0 fixture receipts remain loadable but their default/config-only model ids are unproven', async () => {
  const historicalRun = JSON.parse(await readFile(new URL('../../../data/worlds/receipts/proof0-live-3.json', import.meta.url), 'utf8'));
  const historicalReceipts = historicalRun.cases[0].actual.traceReceipts;
  assert.ok(historicalReceipts.length > 0);
  for (const historical of historicalReceipts) {
    assert.equal(Object.hasOwn(historical, 'model_source'), false);
    assert.equal(Object.hasOwn(historical, 'model_artifact'), false);
    assert.deepEqual(classifyModelProvenance(historical).provenance, {
      classification: 'legacy_unproven',
      reason: 'legacy receipt has a model id but no response or artifact provenance',
    });
    assert.equal(validateDecisionReceipt(historical).ok, true);
  }
});

test('response-proven frontier receipt proves response identity without invented local fields', () => {
  const validation = validateDecisionReceipt(receipt({
    model_source: 'provider_response',
    model_artifact: frontierArtifact(),
  }));
  assert.equal(validation.ok, true);
  assert.equal(validation.provenance.classification, 'response_proven');

  assert.ok(validateDecisionReceipt(receipt({
    model_source: 'provider_response',
    model_artifact: frontierArtifact({ base_model_id: 'different-response-id' }),
  })).errors.includes('model_artifact.base_model_id must equal the receipt modelId'));
});

test('exact local artifact requires base, quantization, runtime, hardware, and canonical digests', () => {
  const exact = receipt({ modelId: 'local/base-32b', model_source: 'provider_response', model_artifact: localArtifact() });
  assert.equal(validateDecisionReceipt(exact).ok, true);

  for (const field of ['base_model_id', 'base_model_digest', 'quantization', 'runtime', 'runtime_version', 'hardware_profile']) {
    const validation = validateDecisionReceipt(receipt({
      modelId: 'local/base-32b',
      model_source: 'provider_response',
      model_artifact: localArtifact({ [field]: unknown('not captured') }),
    }));
    assert.equal(validation.ok, false, field);
    assert.ok(validation.errors.includes(`model_artifact.${field} must be known for local_only execution`), field);
  }
});

test('local and hybrid executions require the same exact deployed identity', () => {
  const hybrid = localArtifact({ execution_mode: 'hybrid', network_egress: true });
  assert.equal(validateDecisionReceipt(receipt({ modelId: hybrid.base_model_id, model_source: 'provider_response', model_artifact: hybrid })).ok, true);

  for (const field of ['base_model_digest', 'quantization', 'runtime', 'runtime_version', 'hardware_profile']) {
    const model_artifact = { ...hybrid, [field]: unknown('not captured') };
    const validation = validateDecisionReceipt(receipt({ modelId: hybrid.base_model_id, model_source: 'provider_response', model_artifact }));
    assert.equal(validation.ok, false, field);
    assert.ok(validation.errors.includes(`model_artifact.${field} must be known for hybrid execution`), field);
  }
});

test('base-only local artifacts use paired not_applicable component identities', () => {
  const baseOnly = localArtifact({ adapter_id: na(), adapter_digest: na(), vision_projector_digest: na() });
  assert.equal(validateDecisionReceipt(receipt({ modelId: baseOnly.base_model_id, model_source: 'provider_response', model_artifact: baseOnly })).ok, true);

  for (const overrides of [
    { adapter_id: na() },
    { adapter_digest: na() },
    { adapter_id: unknown('not captured'), adapter_digest: unknown('not captured') },
    { vision_projector_digest: unknown('not captured') },
  ]) {
    const model_artifact = localArtifact(overrides);
    assert.equal(validateDecisionReceipt(receipt({ modelId: model_artifact.base_model_id, model_source: 'provider_response', model_artifact })).ok, false);
  }
});

test('artifact digests require canonical lowercase SHA-256 values', () => {
  for (const [field, value] of [
    ['base_model_digest', 'not-a-digest'],
    ['base_model_digest', digest('A')],
    ['adapter_digest', digest('B')],
    ['vision_projector_digest', digest('C')],
  ]) {
    const model_artifact = localArtifact({ [field]: value });
    const validation = validateDecisionReceipt(receipt({ modelId: model_artifact.base_model_id, model_source: 'provider_response', model_artifact }));
    assert.ok(validation.errors.includes(`model_artifact.${field} must be a lowercase SHA-256 digest`), field);
  }
});

test('configured fallback is explicit and distinct from response provenance', () => {
  const validation = validateDecisionReceipt(receipt({
    model_source: 'configured_fallback',
    model_artifact: frontierArtifact({ model_id_source: 'configured_fallback', fallback_occurred: true }),
  }));
  assert.equal(validation.ok, true);
  assert.equal(validation.provenance.classification, 'configured_fallback');
});

test('egress and fallback contradictions fail closed', () => {
  const cases = [
    frontierArtifact({ network_egress: false }),
    frontierArtifact({ fallback_occurred: true }),
    localArtifact({ network_egress: true }),
    localArtifact({ fallback_occurred: true }),
  ];
  for (const model_artifact of cases) {
    assert.equal(validateDecisionReceipt(receipt({ modelId: model_artifact.base_model_id, model_source: 'provider_response', model_artifact })).ok, false);
  }
  assert.equal(validateDecisionReceipt(receipt({
    model_source: 'configured_fallback',
    model_artifact: frontierArtifact({ model_id_source: 'configured_fallback' }),
  })).ok, false);
});

test('unknown applicability is explicit and never accepted as empty or zero', () => {
  for (const quantization of ['', 0, {}, { status: 'unknown' }]) {
    assert.equal(validateDecisionReceipt(receipt({
      model_source: 'provider_response',
      model_artifact: frontierArtifact({ quantization }),
    })).ok, false);
  }
});

test('earliest divergence picks the first observable matching receipt, not the last failure', async () => {
  const spec = world();
  const policyPack = await readProof0PolicyPack();
  const expected = buildExpectedClose(spec, policyPack);
  const verdict = evaluateCandidateClose(spec, policyPack, applyFeeAsRevenueMutation(expected));

  const analysis = findEarliestObservableDivergence({
    oracleVerdict: verdict,
    traceReceipts: [
      receipt({ decisionId: 'decision/final', stage: 'final_close_and_external_state', expectedState: 'balanced_close', observedState: 'failed_close', oracleFailureIds: [] }),
      receipt(),
    ],
  });

  assert.equal(analysis.ok, true);
  assert.deepEqual(analysis.divergence, { stage: 'tool_calls_and_arithmetic', expectedState: 'processor_fee_expense', observedState: 'sales_revenue', confidence: 'high', decisionId: 'decision/fee-treatment' });
});

test('failure receipt carries oracle receipts, consequence, and fallback uncertainty when trace is incomplete', async () => {
  const spec = world();
  const policyPack = await readProof0PolicyPack();
  const expected = buildExpectedClose(spec, policyPack);
  const verdict = evaluateCandidateClose(spec, policyPack, applyFeeAsRevenueMutation(expected));
  const failure = buildFailureReceipt({
    failureId: 'failure/proof0/fee-as-revenue',
    worldSpec: spec,
    failureClass: 'fee_as_revenue',
    oracleVerdict: verdict,
    traceReceipts: [],
    consequence: { accounting: 'processor_fee_overstates_sales' },
    permittedPatchSurfaces: ['evidence_context'],
    protectedSurfaces: ['causal_world', 'oracle', 'policy_pack'],
  });

  assert.equal(failure.ok, true);
  assert.equal(failure.receipt.receiptVersion, TRACE_RECEIPTS_VERSION);
  assert.equal(failure.receipt.worldId, 'proof0/trace-processor-settlement');
  assert.equal(failure.receipt.earliestObservableDivergence.stage, 'final_close_and_external_state');
  assert.equal(failure.receipt.earliestObservableDivergence.confidence, 'uncertain');
  assert.deepEqual(failure.receipt.oracleReceiptIds, ['oracle-receipt/proof0/trace-processor-settlement']);
  assert.deepEqual(failure.receipt.permittedPatchSurfaces, ['evidence_context']);
});
