import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildFreshEntityDiagnosticReceipt,
  evaluateFreshEntityReplayAdmission,
  sha256Hex,
  validateDiagnosticReceipt,
} from './freshEntityDiagnostic.js';

const artifactBytes = await readFile(new URL('../../../data/worlds/reproducers/fresh-entity-baseline-seed-failure-artifact-v1.json', import.meta.url));

const stageReceipt = ({ afterFailurePass = false } = {}) => [
  { stage: 'create_path', status: 'passed', receipt_ids: ['route/create-request'] },
  { stage: 'build_and_migration', status: 'passed', receipt_ids: ['build/ad0770db', 'migration/121'] },
  { stage: 'canonical_identity', status: 'passed', receipt_ids: ['identity/canonical-gb-ltd'] },
  { stage: 'config_chart_authority', status: 'failed', reason_code: 'DESKTOP_BASELINE_SEED_FAILED', receipt_ids: ['seed/failure-1'] },
  { stage: 'first_upload', status: afterFailurePass ? 'passed' : 'not_reached', reason_code: afterFailurePass ? null : 'UPSTREAM_STAGE_FAILED', receipt_ids: afterFailurePass ? ['upload/should-not-exist'] : [] },
  { stage: 'worker_stage', status: 'not_reached', reason_code: 'UPSTREAM_STAGE_FAILED', receipt_ids: [] },
];

async function diagnostic() {
  const path = 'data/worlds/reproducers/fresh-entity-baseline-seed-failure-v1.json';
  const reproducerBytes = await readFile(new URL('../../../data/worlds/reproducers/fresh-entity-baseline-seed-failure-v1.json', import.meta.url));
  const receipt = buildFreshEntityDiagnosticReceipt({
    incidentId: 'fresh-entity/baseline-seed-failure',
    observedAt: '2026-08-29T12:00:00.000Z',
    firmId: 'eaw-fictional-firm',
    clientId: 'eaw-fictional-client',
    creationPath: 'desktop_firm_intake',
    stages: stageReceipt(),
    retainedArtifact: {
      artifact_id: 'artifact/fresh-entity-seed-failure',
      sha256: sha256Hex(artifactBytes),
      retention_status: 'retained',
      source_class: 'fictional',
      authorization: { status: 'authorized', purpose: 'diagnostic_replay', authority_id: 'eaw-test-authority' },
    },
    fictionalReproducer: {
      fictional: true,
      incident_id: 'fresh-entity/baseline-seed-failure',
      world_id: 'gate0/fresh-entity-baseline-seed-failure',
      expected_divergence_stage: 'config_chart_authority',
      path,
      sha256: sha256Hex(reproducerBytes),
    },
  });
  return { receipt, reproducerBytes };
}

test('localizes one fresh-entity failure and suppresses downstream pseudo-failures', async () => {
  const { receipt } = await diagnostic();
  const committed = JSON.parse(await readFile(new URL('../../../data/worlds/receipts/gate0a-fresh-entity-baseline-seed-failure.json', import.meta.url), 'utf8'));
  assert.deepEqual(receipt, committed, 'the committed exit receipt must be reproducible from the deterministic builder');
  assert.equal(receipt.status, 'failed');
  assert.deepEqual(receipt.first_divergence, {
    stage: 'config_chart_authority',
    status: 'failed',
    reason_code: 'DESKTOP_BASELINE_SEED_FAILED',
    receipt_ids: ['seed/failure-1'],
  });
  assert.deepEqual(receipt.stages.slice(4).map(({ status }) => status), ['not_reached', 'not_reached']);
  assert.equal(receipt.spend.solveCalls, 0);
  assert.deepEqual(validateDiagnosticReceipt(receipt), { ok: true, errors: [] });
  assert.throws(
    () => buildFreshEntityDiagnosticReceipt({
      incidentId: 'fresh-entity/baseline-seed-failure', observedAt: '2026-08-29T12:00:00.000Z',
      firmId: 'firm', clientId: 'client', creationPath: 'desktop_firm_intake', stages: stageReceipt({ afterFailurePass: true }),
    }),
    /cannot pass after the first divergence|must be not_reached after the first divergence/,
  );
});

test('replay requires the retained authorized bytes, not the diagnostic receipt alone', async () => {
  const { receipt } = await diagnostic();
  assert.equal(evaluateFreshEntityReplayAdmission({ receipt }).reason, 'retained_artifact_bytes_required');
  assert.equal(evaluateFreshEntityReplayAdmission({ receipt, retainedArtifactBytes: Buffer.from('wrong') }).reason, 'retained_artifact_digest_mismatch');
  assert.deepEqual(evaluateFreshEntityReplayAdmission({ receipt, retainedArtifactBytes: artifactBytes }), {
    admitted: true,
    scope: 'diagnostic_replay',
    artifact_id: 'artifact/fresh-entity-seed-failure',
  });
});

test('protected-corpus admission additionally requires the exact minimized fictional reproducer', async () => {
  const { receipt, reproducerBytes } = await diagnostic();
  assert.equal(evaluateFreshEntityReplayAdmission({
    receipt, retainedArtifactBytes: artifactBytes, protectedCorpus: true,
  }).reason, 'fictional_reproducer_bytes_required');
  assert.equal(evaluateFreshEntityReplayAdmission({
    receipt, retainedArtifactBytes: artifactBytes, fictionalReproducerBytes: Buffer.from('{}'), protectedCorpus: true,
  }).reason, 'fictional_reproducer_digest_mismatch');
  assert.deepEqual(evaluateFreshEntityReplayAdmission({
    receipt, retainedArtifactBytes: artifactBytes, fictionalReproducerBytes: reproducerBytes, protectedCorpus: true,
  }), {
    admitted: true,
    scope: 'protected_corpus',
    artifact_id: 'artifact/fresh-entity-seed-failure',
    world_id: 'gate0/fresh-entity-baseline-seed-failure',
    reproducer_path: 'data/worlds/reproducers/fresh-entity-baseline-seed-failure-v1.json',
  });
});

test('receipt digests fail closed after report mutation', async () => {
  const { receipt } = await diagnostic();
  const tampered = structuredClone(receipt);
  tampered.stages[3].reason_code = 'DIFFERENT_FAILURE';
  assert.ok(validateDiagnosticReceipt(tampered).errors.includes('receipt_digest does not match receipt contents'));
  assert.ok(validateDiagnosticReceipt(tampered).errors.includes('first_divergence does not match the ordered stage observations'));
  assert.equal(evaluateFreshEntityReplayAdmission({ receipt: tampered, retainedArtifactBytes: artifactBytes }).reason, 'diagnostic_receipt_invalid');
});
