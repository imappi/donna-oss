import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { carryPinnedSolverModuleIdentity, loadPinnedSolverModule, pinSolverModule } from './eval_world_close.js';
import { parseArgs, RUN_COUNT, runMatcherVariance, writeReceiptExclusive } from './eval_world_matcher_variance.js';

const world = JSON.parse(readFileSync(new URL('../data/worlds/proof0.json', import.meta.url), 'utf8'));

test('CLI supports filter, print, and exclusive output', () => {
  assert.deepEqual(parseArgs(['--filter=proof0', '--solver-module=adapter.js', '--print', '--output=out.json']), {
    filter: 'proof0', solverModule: 'adapter.js', print: true, output: 'out.json',
  });
  assert.throws(() => parseArgs(['--solver-module=x']), /--filter is required/);
  const dir = mkdtempSync(join(tmpdir(), 'eaw-variance-'));
  try {
    const output = join(dir, 'receipt.json');
    writeReceiptExclusive(output, '{}\n');
    assert.equal(readFileSync(output, 'utf8'), '{}\n');
    assert.throws(() => writeReceiptExclusive(output, '{}\n'), { code: 'EEXIST' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('records exactly K=3 observed matcher outcomes without turning agreement into correctness', async () => {
  let call = 0;
  const solver = async ({ worldId, capability }) => {
    call += 1;
    const proposed = call !== 2;
    const modelId = `provider-response-${call}`;
    const outcomes = ['artifact/invoice-a', 'artifact/invoice-b'].map((invoiceArtifactId) => ({
      invoiceArtifactId, expectedToSettle: true, proposedBankArtifactIds: proposed ? ['artifact/bank-line'] : [],
    }));
    return {
      resolvedModelId: modelId, candidateClose: { entries: [], ownerFacts: [], actions: [] },
      traceReceipts: [{
        receiptVersion: 'proof0.traceReceipts.v1', decisionId: `decision/${worldId}/matching`, worldId,
        capabilityId: capability.capabilityId, stage: 'candidate_state_alternatives', obligationIds: [], evidenceRefs: [],
        retrievedMemoryRefs: [], policyRefs: [], admissibleBranches: [], selectedAction: 'observe', authorityBasis: 'offline_eval',
        sourceTrust: 'verified_evidence', reversibility: 'no_mutation', externalConsequence: 'none', nextState: 'observed',
        modelId, runtimeSnapshot: { perInvoiceOutcomes: outcomes }, oracleFailureIds: [], expectedState: 'two_matches',
        observedState: proposed ? '2/2' : '0/2', sequence: 1,
      }], failureClass: 'characterization', permittedPatchSurfaces: [],
    };
  };
  const pinned = await loadPinnedSolverModule(pinSolverModule(fileURLToPath(new URL('./eval_world_proof0_adapter.js', import.meta.url))));
  carryPinnedSolverModuleIdentity(solver, pinned.solveWorldClose);
  const receipt = await runMatcherVariance({ worldSpec: world, solveWorldClose: solver });
  assert.equal(receipt.k, RUN_COUNT);
  assert.deepEqual(receipt.runs.map(({ observedState }) => observedState), ['2/2', '0/2', '2/2']);
  assert.ok(receipt.runs.every(({ modelSource }) => modelSource === 'response_receipt'));
  assert.ok(receipt.runs.every(({ usage }) => usage.status === 'UNKNOWN-NOT-ZERO'));
  assert.ok(receipt.runs.every(({ solverDigest }) => /^[0-9a-f]{64}$/.test(solverDigest)));
  assert.equal(receipt.observedAgreement, false);
  assert.equal(receipt.correctnessClaim, null);
  assert.equal(receipt.productionPromptStatus, 'unresolved');
});
