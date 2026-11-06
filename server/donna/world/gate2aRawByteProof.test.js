import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  GATE2A_RAW_BYTE_RECEIPT_VERSION,
  buildGate2aRawByteReceipt,
  orderedDiagnosticStages,
  selectGate2aRenderedArtifact,
  validateGate2aWorld,
} from './gate2aRawByteProof.js';
import { renderWorldArtifacts } from './worldRenderer.js';

const loadWorld = async () => JSON.parse(await fs.readFile('data/worlds/gate2a-raw-byte-month.json', 'utf8'));
const allStages = () => Object.fromEntries([
  'create_path',
  'build_and_migration',
  'canonical_identity',
  'config_chart_authority',
  'first_upload',
  'worker_stage',
].map((stage, index) => [stage, { status: 'passed', receipt_ids: [`receipt-${index + 1}`] }]));

test('Gate 2A world is causal and renders one deterministic PDF first document', async () => {
  const world = await loadWorld();
  assert.deepEqual(validateGate2aWorld(world), { ok: true, errors: [] });
  const first = selectGate2aRenderedArtifact({ world, rendered: await renderWorldArtifacts(world) });
  const second = selectGate2aRenderedArtifact({ world, rendered: await renderWorldArtifacts(world) });
  assert.equal(first.artifact.id, world.gate2a.firstDocumentArtifactId);
  assert.equal(first.artifact.format, 'pdf');
  assert.equal(first.raw_sha256, second.raw_sha256);
  assert.deepEqual(first.bytes, second.bytes);
  assert.notEqual(first.raw_sha256, first.artifact.sha256, 'raw bytes and renderer base64-payload digests stay explicitly distinct');
});

test('Gate 2A successful receipt proves exact raw-byte lineage and refuses broader C1 claims', async () => {
  const world = await loadWorld();
  const selected = selectGate2aRenderedArtifact({ world, rendered: await renderWorldArtifacts(world) });
  const hash = selected.raw_sha256;
  const documentId = 'eaw-proof-client-1-first-document';
  const receipt = buildGate2aRawByteReceipt({
    world,
    renderedArtifact: selected,
    firmId: 'eaw-proof',
    clientId: 'eaw-proof-client-1',
    documentId,
    observedAt: '2026-08-30T08:00:00.000Z',
    stageResults: allStages(),
    routeReceipts: {
      upload_sign: { provider: 'local_blob', checksum_sha256: hash },
      blob_put: { content_hash: hash, byte_length: selected.byte_length },
      register: { documents: [{ id: documentId, parse_run_id: 'parse-1', parse_status: 'pending', event_sent: false }] },
    },
    persisted: {
      expected_document_id: documentId,
      host: { status: 'PASS' },
      readiness: { state: 'ready' },
      storage: { bucket: 'evidence', key: 'key', content_hash: hash, byte_length: selected.byte_length },
      document: {
        id: documentId,
        source: 'firm_intake',
        document_type: 'bank_statement',
        storage_bucket: 'evidence',
        storage_object_key: 'key',
        checksum_sha256: hash,
        parse_status: 'completed',
        parse_run_id: 'parse-1',
        parse_summary: { transaction_count: 1 },
      },
      transactions: [{
        id: 'tx-1', document_id: documentId, transaction_date: '2026-08-05',
        money_in: 100, money_out: 0, currency: 'GBP', status: 'needs_review',
        payload: { source: 'async_parse', source_document_id: documentId },
      }],
      counts: { clients: 1, documents: 1, transactions: 1 },
      audit_events: [{ id: 1, action: 'document.parse.completed' }],
    },
    isolation: { external_destinations: 'isolated', counts: { firm_members: 1 } },
    cleanup: {
      delete_receipt: { residue_verified: true },
      post_delete_residue: { residue_rows: 0 },
      errors: [],
    },
    wallTimeMs: 42,
  });

  assert.equal(receipt.version, GATE2A_RAW_BYTE_RECEIPT_VERSION);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.product_handshake.terminal, 'ready_document_work_queued');
  assert.equal(receipt.source_inventory.storage.content_hash, hash);
  assert.equal(receipt.source_inventory.parsed_transactions[0].source, 'async_parse');
  assert.equal(receipt.source_inventory.injection_guard.documents_sync_route_invoked, false);
  assert.ok(receipt.scope.excludes.includes('C1'));
  assert.equal(receipt.spend.solveCalls, 0);
  assert.match(receipt.receipt_digest, /^[0-9a-f]{64}$/);
});

test('Gate 2A diagnostic stops at the first divergence and keeps a failed first workload visible', async () => {
  const world = await loadWorld();
  const selected = selectGate2aRenderedArtifact({ world, rendered: await renderWorldArtifacts(world) });
  const stages = orderedDiagnosticStages({
    create_path: { status: 'passed', receipt_ids: ['create'] },
    build_and_migration: { status: 'passed', receipt_ids: ['host'] },
    canonical_identity: { status: 'passed', receipt_ids: ['identity'] },
    config_chart_authority: { status: 'passed', receipt_ids: ['ready'] },
    first_upload: { status: 'failed', reason_code: 'REGISTER_FAILED', receipt_ids: ['register-failure'] },
  });
  assert.equal(stages[4].status, 'failed');
  assert.equal(stages[5].status, 'not_reached');

  const receipt = buildGate2aRawByteReceipt({
    world,
    renderedArtifact: selected,
    firmId: 'eaw-failure',
    clientId: 'eaw-failure-client-1',
    documentId: 'eaw-failure-client-1-first-document',
    observedAt: '2026-08-30T08:00:00.000Z',
    stageResults: Object.fromEntries(stages.filter(({ status }) => status !== 'not_reached').map((entry) => [entry.stage, entry])),
    routeReceipts: { first_workload_failure: { code: 'REGISTER_FAILED' } },
    failure: { code: 'REGISTER_FAILED', message: 'registration refused' },
  });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.first_divergence.stage, 'first_upload');
  assert.equal(receipt.product_handshake.terminal, 'explicit_first_workload_failure');
  assert.equal(receipt.product_handshake.first_workload_visible, true);
});

test('Gate 2A rejects a text/CSV artifact because mounted intake does not retain those bytes', async () => {
  const world = await loadWorld();
  world.gate2a.mimeType = 'text/csv';
  world.artifacts[0].format = 'json';
  const validation = validateGate2aWorld(world);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes('mounted intake retains the raw bytes')));
});
