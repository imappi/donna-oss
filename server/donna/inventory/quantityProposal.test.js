import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { telemetryFromParts } from '../llmCall.js';
import { buildBlindQuantityRequest, quantityProposalFromEnvelope, validateQuantityResult } from './quantityProposal.js';
import { proposePhysicalObservation, validatePhysicalResolution } from './physicalReconciliation.js';

export const blindInput = () => ({ scope: { firmId: 'fixture-f', clientId: 'fixture-c', locationId: 'fixture-l' },
  protocolVersion: 'physical-quantity-blind.v1', candidates: [{ itemId: 'a', sku: 'FIXTURE-A', baseUom: 'EA' }],
  evidence: [{ id: 'frame', checksum: 'a'.repeat(64), sourceGroupId: 'one-scene' }] });
export const exactResult = () => ({ candidateItemId: 'a', alternativeItemIds: [], baseUom: 'EA',
  quantity: { kind: 'exact', value: 3, lower: null, upper: null }, evidenceRefs: ['frame'],
  limitations: [], ambiguity: '', confidence: .8 });
export const fixtureEnvelope = (result = { ...exactResult(), candidateItemId: 'candidate_1', evidenceRefs: ['evidence_1'] }) => ({ result,
  telemetry: telemetryFromParts({ provider: 'synthetic_contract', payload: { model: 'synthetic-contract-stub', id: 'stub-only',
    usage: { input_tokens: 0, output_tokens: 0 } }, requestedModel: 'unused-request',
    execution: { root: { type: 'offline_quantity_contract', id: 'fixture-run' } },
    promptVersion: 'physical-quantity-blind.v1', latencyMs: 0, status: 200 }) });
const adapt = (input = blindInput(), envelope = fixtureEnvelope()) => quantityProposalFromEnvelope({ input, envelope,
  recordingKind: 'synthetic_contract', recordedAt: '2026-10-07T00:00:00Z' });

test('blind prompt/schema refuse expected ledger facts and holdout labels at every input layer', () => {
  for (const change of [i => { i.expectedQuantity = 42; }, i => { i.candidates[0].expected_quantity = 42; },
    i => { i.evidence[0].fixtureLabel = 3; }, i => { i.scope.valuation = 200; },
    i => { i.constructor = 'not a declared field'; }, i => { i.evidence[0].toString = 'not a declared field'; }]) {
    const input = blindInput(); change(input);
    assert.throws(() => buildBlindQuantityRequest(input), { code: 'QUANTITY_CONTRACT_INVALID' });
  }
  const request = buildBlindQuantityRequest(blindInput());
  assert.equal(request.input.candidates[0].baseUom, 'EA');
  assert.equal(request.input.candidates[0].itemId, 'candidate_1');
  assert.equal(request.input.evidence[0].id, 'evidence_1');
  assert.equal(JSON.stringify(request.input).includes('fixture-f'), false);
  assert.equal(JSON.stringify(request.input).includes('one-scene'), false);
  assert.equal(request.responseSchema.additionalProperties, false);
  assert.match(request.system, /untrusted data/);
  assert.match(request.system, /duplicate frames/);
  const inherited = blindInput(); inherited.candidates[0] = Object.create(inherited.candidates[0]);
  assert.throws(() => buildBlindQuantityRequest(inherited), { code: 'QUANTITY_CONTRACT_INVALID' });
});

test('exact, unknown identity and bounded ranges preserve uncertainty without manufacturing counts', () => {
  const input = blindInput();
  assert.equal(adapt().quantity.value, 3);
  for (const result of [
    { ...exactResult(), quantity: { kind: 'range', value: null, lower: 2, upper: 5 }, limitations: ['occlusion'], ambiguity: 'Hidden rear row' },
    { ...exactResult(), candidateItemId: null, baseUom: null, alternativeItemIds: ['a'],
      quantity: { kind: 'unknown', value: null, lower: null, upper: null }, limitations: ['unreadable_label'], ambiguity: 'Label unreadable' }
  ]) assert.deepEqual(validateQuantityResult(input, result), result);
  const mutations = [r => { r.quantity.value = '3'; }, r => { r.quantity.value = -1; }, r => { r.quantity.value = NaN; },
    r => { r.constructor = 'not a declared field'; }, r => { r.quantity.toString = 'not a declared field'; },
    r => { r.quantity.upper = 5; }, r => { r.confidence = 1.01; }, r => { r.humanConfirmed = true; },
    r => { r.candidateItemId = 'other-client'; }, r => { r.baseUom = 'BOX'; },
    r => { r.evidenceRefs = ['other-client-frame']; }, r => { r.evidenceRefs = ['frame', 'frame']; },
    r => { r.quantity = { kind: 'unknown', value: null, lower: null, upper: null }; },
    r => { r.alternativeItemIds = ['other-client']; }];
  for (const change of mutations) { const r = exactResult(); change(r); assert.throws(() => validateQuantityResult(input, r)); }
  for (const extra of ['constructor', '__proto__', 'toString']) {
    const r = JSON.parse(JSON.stringify(exactResult()).replace(/}$/, `,"${extra}":"undeclared"}`));
    assert.throws(() => validateQuantityResult(input, r), { code: 'QUANTITY_CONTRACT_INVALID' });
  }
  assert.throws(() => validateQuantityResult(input, Object.create(exactResult())), { code: 'QUANTITY_CONTRACT_INVALID' });
});

test('existing inference envelope keeps actual response provenance, deterministic digests and immutable input', () => {
  const input = blindInput(), envelope = fixtureEnvelope();
  const proposal = adapt(input, envelope);
  assert.deepEqual(adapt(input, envelope), proposal);
  assert.equal(proposal.provenance.model, envelope.telemetry.model);
  assert.equal(proposal.provenance.telemetry.rootExecutionId, 'fixture-run');
  input.candidates[0].sku = 'changed'; envelope.result.quantity.value = 7;
  envelope.telemetry.usage.input_tokens = 99;
  envelope.telemetry.prompt_sections.total_bytes = 99;
  assert.equal(proposal.candidateSku, 'FIXTURE-A'); assert.equal(proposal.quantity.value, 3);
  assert.equal(proposal.provenance.telemetry.usage.input_tokens, 0);
  assert.equal(proposal.provenance.telemetry.promptSections.total_bytes, 0);
  for (const change of [e => { e.telemetry.model_source = 'request'; }, e => { e.telemetry.ok = false; },
    e => { e.telemetry.prompt_version = 'changed'; }, e => { e.telemetry.root_execution = null; },
    e => { e.telemetry.model = null; }]) { const e = fixtureEnvelope(); change(e); assert.throws(() => adapt(blindInput(), e)); }
});

test('only call-local candidate and evidence handles reach the model and are mapped back', () => {
  const input = blindInput(); input.candidates[0].itemId = 'db-item-long-opaque-id'; input.evidence[0].id = 'db-document-opaque-id';
  const request = buildBlindQuantityRequest(input);
  assert.equal(JSON.stringify(request.input).includes('opaque'), false);
  const proposal = adapt(input);
  assert.equal(proposal.candidateItemId, 'db-item-long-opaque-id');
  assert.deepEqual(proposal.evidenceRefs, ['db-document-opaque-id']);
  const envelope = fixtureEnvelope(); envelope.result.candidateItemId = 'db-item-long-opaque-id';
  assert.throws(() => adapt(input, envelope), { code: 'QUANTITY_HANDLE_REFUSED' });
});

test('model proposal is distinct from a human observation and cannot authorize correction', () => {
  const proposal = adapt();
  assert.equal(proposal.kind, 'quantity_proposal'); assert.equal(proposal.humanConfirmed, false);
  assert.equal(proposePhysicalObservation(proposal).reason, 'invalid_quantity');
  const proposed = proposePhysicalObservation({ expectedQuantity: 4, observedQuantity: proposal.quantity.value,
    evidenceRefs: ['frame'], observedAt: '2026-10-07T01:00:00Z', cutoff: '2026-10-07T00:00:00Z',
    asOf: '2026-10-07T02:00:00Z', modelReceipt: proposal.provenance, humanConfirmed: false });
  assert.equal(proposed.status, 'uncertain');
  assert.equal(validatePhysicalResolution({ line: { physical_status: proposed.status, physical_observation: proposed.observation },
    action: 'confirmed_shortage', reason: 'Model count alone' }).reason, 'human_confirmation_required');
  const source = readFileSync(new URL('./quantityProposal.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['../operatorContract.js', '../llmCall.js', './physicalReconciliation.js']);
  assert.equal(/\b(fetch|llmCall|postInventoryJournal|applyInventoryOperation)\s*\(/.test(source), false);
});
