import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDecisionReceipt } from '../server/donna/world/traceReceipts.js';
import { loadSolveWorldClose, parseArgs, runSiblingWorldClose, writeReceiptExclusive } from './eval_world_sibling.js';

const proof0 = () => JSON.parse(readFileSync(new URL('../data/worlds/proof0.json', import.meta.url), 'utf8'));

function failingSolver({ worldId, capability }) {
  return {
    resolvedModelId: 'provider-response-test',
    candidateClose: { candidateId: 'candidate/sibling', entries: [], ownerFacts: [], actions: [] },
    traceReceipts: [createDecisionReceipt({
      decisionId: 'decision/sibling-close', worldId, capabilityId: capability.capabilityId,
      stage: 'final_close_and_external_state', selectedAction: 'block', authorityBasis: 'declared_mandate',
      sourceTrust: 'verified_evidence', reversibility: 'reversible', externalConsequence: 'books_only',
      nextState: 'blocked', modelId: 'provider-response-test', expectedState: 'admissible_close',
      observedState: 'missing_entries', sequence: 1,
    })],
    failureClass: 'whole_close_oracle_failure',
  };
}

function responseProvenFailingSolver(input) {
  const result = failingSolver(input);
  const notApplicable = { status: 'not_applicable' };
  result.traceReceipts[0] = {
    ...result.traceReceipts[0],
    receiptVersion: 'proof0.traceReceipts.v2',
    model_source: 'provider_response',
    model_artifact: {
      provider: 'test-provider', base_model_id: 'provider-response-test', base_model_digest: notApplicable,
      adapter_id: notApplicable, adapter_digest: notApplicable, quantization: notApplicable,
      runtime: 'provider-api', runtime_version: 'test-v1', vision_projector_digest: notApplicable,
      tool_protocol_version: notApplicable, prompt_snapshot_id: 'prompt/test', retrieval_snapshot_id: notApplicable,
      routing_snapshot_id: notApplicable, hardware_profile: notApplicable, execution_mode: 'frontier',
      model_id_source: 'provider_response', network_egress: true, fallback_occurred: false,
    },
  };
  return result;
}

test('parses the close-driver flags and requires a production adapter', () => {
  assert.deepEqual(parseArgs(['--filter=proof0', '--solver-module=adapter.js', '--output=receipt.json', '--print']), {
    filter: 'proof0', solverModule: 'adapter.js', output: 'receipt.json', print: true,
  });
  assert.throws(() => parseArgs([]), /--solver-module is required/);
  assert.throws(() => parseArgs(['--solver-module=']), /requires a value/);
  assert.throws(() => parseArgs(['--solver-module=x', '--unknown']), /unknown argument/);
});

test('derives the persisted sibling and executes it through the real whole-close seam', async () => {
  const source = proof0();
  let solverInput = null;
  const receipt = await runSiblingWorldClose({
    sourceWorld: source,
    solveWorldClose: async (input) => { solverInput = input; return failingSolver(input); },
    runtime: { donnaCommit: 'test-commit' },
  });
  assert.equal(receipt.status, 'fail', 'a genuine sibling failure must remain a failure');
  assert.equal(receipt.sourceWorldId, source.worldId);
  assert.equal(receipt.siblingWorldId, `${source.worldId}::sibling::${source.counterfactualMutation.id}`);
  assert.equal(solverInput.worldId, receipt.siblingWorldId);
  assert.equal(receipt.run.worldId, receipt.siblingWorldId);
  assert.equal(receipt.run.provenance.donnaCommit, 'test-commit');
  assert.deepEqual(receipt.provenance, {
    solverModule: null,
    scorerIdentity: receipt.run.provenance.scorerIdentity,
  });
  assert.equal(receipt.provenance.scorerIdentity.classification, 'legacy_unproven');
});

test('propagates the pinned solver digest and legacy scorer source without relabelling either', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaw-sibling-solver-'));
  const modulePath = join(dir, 'solver.mjs');
  const moduleSource = `
export async function solveWorldClose({ worldId, capability }) {
  return {
    resolvedModelId: 'provider-response-test',
    candidateClose: { candidateId: 'candidate/sibling', entries: [], ownerFacts: [], actions: [] },
    traceReceipts: [{
      receiptVersion: 'proof0.traceReceipts.v1', decisionId: 'decision/sibling-close', worldId,
      capabilityId: capability.capabilityId, stage: 'final_close_and_external_state', obligationIds: [],
      evidenceRefs: [], retrievedMemoryRefs: [], policyRefs: [], admissibleBranches: [], selectedAction: 'block',
      authorityBasis: 'declared_mandate', sourceTrust: 'verified_evidence', reversibility: 'reversible',
      externalConsequence: 'books_only', nextState: 'blocked', modelId: 'provider-response-test',
      runtimeSnapshot: {}, oracleFailureIds: [], expectedState: 'admissible_close', observedState: 'missing_entries', sequence: 1
    }],
    failureClass: 'whole_close_oracle_failure'
  };
}
`;
  try {
    writeFileSync(modulePath, moduleSource);
    const solveWorldClose = await loadSolveWorldClose(modulePath);
    const receipt = await runSiblingWorldClose({ sourceWorld: proof0(), solveWorldClose });
    assert.match(receipt.provenance.solverModule.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(receipt.provenance.solverModule, receipt.run.provenance.solverModule);
    assert.equal(receipt.provenance.scorerIdentity.classification, 'legacy_unproven');
    assert.equal(receipt.provenance.scorerIdentity.modelSource, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports derivation errors verbatim and never invokes the solver', async () => {
  const source = proof0();
  source.counterfactualMutation.changedFactIds = ['hidden/not-declared'];
  let calls = 0;
  const receipt = await runSiblingWorldClose({ sourceWorld: source, solveWorldClose: async () => { calls += 1; } });
  assert.equal(receipt.status, 'derivation_refused');
  assert.deepEqual(receipt.derivation.errors, [
    'sourceWorld.counterfactualMutation.changedFactIds may only include declaredFactId, found hidden/not-declared',
  ]);
  assert.equal(receipt.run, null);
  assert.equal(calls, 0);
});

test('an adapter failure remains a machine-readable sibling receipt with its spend evidence', async () => {
  const receipt = await runSiblingWorldClose({
    sourceWorld: proof0(),
    solveWorldClose: async () => {
      const error = new Error('provider transport failed');
      error.modelUsage = {
        version: 'eaw.model-usage.v1', status: 'incomplete',
        calls: [{ outcome: 'transport_error' }], incomplete_fields: ['calls[0].response_id'],
        cash: { status: 'unknown', reason: 'response_model_price_missing' },
      };
      throw error;
    },
  });
  assert.equal(receipt.status, 'adapter_error');
  assert.deepEqual(receipt.run.errors, ['provider transport failed']);
  assert.equal(receipt.run.modelUsage.calls[0].outcome, 'transport_error');
  assert.match(receipt.run.modelUsage.configuration_digest, /^[0-9a-f]{64}$/);
  assert.ok(receipt.run.modelUsage.artifact_digests.length > 0);
});

test('does not drop provider-response scorer provenance from the sibling receipt', async () => {
  const receipt = await runSiblingWorldClose({ sourceWorld: proof0(), solveWorldClose: responseProvenFailingSolver });
  assert.equal(receipt.provenance.scorerIdentity.classification, 'response_proven');
  assert.equal(receipt.provenance.scorerIdentity.modelSource, 'provider_response');
  assert.deepEqual(receipt.provenance.scorerIdentity, receipt.run.provenance.scorerIdentity);
});

test('exclusive receipt writes refuse to clobber an existing output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaw-sibling-'));
  const output = join(dir, 'receipt.json');
  try {
    writeFileSync(output, 'existing evidence\n');
    assert.throws(() => writeReceiptExclusive(output, '{}\n'), { code: 'EEXIST' });
    assert.equal(readFileSync(output, 'utf8'), 'existing evidence\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
