import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  HOST_CERTIFICATE_A_VERSION,
  HOST_COMPATIBILITY_CONTRACT_VERSION,
  buildHostCertificateFreshness,
  hostCompatibilityDigest,
  hostDigest
} from '../server/donna/hostCertificateA.js';
import { ENTITY_READINESS_ADMISSION_FLAG, MEMORY_LEGACY_AI_RULE_DEMOTION_FLAG } from '../server/donna/clientConfig.js';
import { DESKTOP_CLIENT_FLAG_SEEDS } from '../server/donna/desktop/hostPlaneSeed.js';
import {
  parseEntityCertificateArgs,
  runEntityCertificateBRealPg
} from './entity_certificate_b.js';

const ROOT = path.resolve(import.meta.dirname, '..');

const hostCertificate = () => {
  const checks = [
    { id: 'database_schema', status: 'PASS', detail: {} },
    { id: 'scheduler_worker_manifest', status: 'PASS', detail: {} },
    { id: 'evidence_storage', status: 'PASS', detail: { provider: 'local_blob' } },
    { id: 'policy_oracle_artifacts', status: 'PASS', detail: {} },
    {
      id: 'config_control_plane',
      status: 'PASS',
      // The real Host A declares DESKTOP_CLIENT_FLAG_SEEDS ∪ AUTO_FORBIDDEN_FLAGS ∪
      // SHADOW_CEILING_FLAGS; the mock names the admitted extensions the
      // contract declares (ENTITY_READINESS_ADMISSION; MEMORY_LEGACY_AI_RULE_DEMOTION — DMEM-R1 W1; MEMORY_MODEL_V2 — DMEM-R1 W2).
      detail: { supported_keys: [...DESKTOP_CLIENT_FLAG_SEEDS, ENTITY_READINESS_ADMISSION_FLAG, MEMORY_LEGACY_AI_RULE_DEMOTION_FLAG, 'MEMORY_MODEL_V2', 'JEV_RECONCILIATION', 'JEV_HELD_PLAN_COMPLETION', 'CODING_CORRECTION_AUTO_APPLY', 'CODING_OWNER_TRANSFER_POST', 'INVENTORY_CORE', 'INVENTORY_ACCOUNTING', 'PHYSICAL_RECONCILIATION', 'PHYSICAL_INVENTORY_APPLY', 'PHYSICAL_CAPTURE_ACCESS'].sort() }
    },
    { id: 'accounting_adapter', status: 'PASS', detail: { registered_external_adapters: ['none', 'xero', 'qbo', 'procountor'] } }
  ];
  const body = {
    version: HOST_CERTIFICATE_A_VERSION,
    status: 'PASS',
    runtime_host: 'desktop',
    compatibility_contract_version: HOST_COMPATIBILITY_CONTRACT_VERSION,
    compatibility_digest: hostCompatibilityDigest({ runtimeHost: 'desktop', checks }),
    freshness: buildHostCertificateFreshness({ mintedAt: '2026-08-29T14:00:00.000Z' }),
    checks
  };
  return { ...body, receipt_digest: hostDigest(body) };
};

test('Certificate B CLI arguments require explicit artifact and Host A paths', () => {
  assert.deepEqual(parseEntityCertificateArgs([
    '--output=artifacts/entity-certificate-b.json',
    '--host-certificate=artifacts/host-certificate-a.json',
    '--require-pass'
  ]), {
    output: 'artifacts/entity-certificate-b.json',
    hostCertificate: 'artifacts/host-certificate-a.json',
    requirePass: true
  });
  assert.throws(() => parseEntityCertificateArgs(['--host-certificate']), /requires a path/);
});

test('required PostgreSQL evidence is INCOMPLETE rather than a skipped green suite', async () => {
  const receipt = await runEntityCertificateBRealPg({
    pgUrl: '',
    hostCertificate: hostCertificate(),
    rootDir: ROOT,
    observedAt: '2026-08-29T14:00:00.000Z'
  });
  assert.equal(receipt.status, 'INCOMPLETE');
  assert.equal(receipt.reason, 'postgresql_test_role_missing');
  assert.equal(receipt.enforcement, false);
  assert.equal(receipt.model_inference_calls, 0);
  assert.equal(receipt.model_spend_usd, 0);
  assert.ok(!JSON.stringify(receipt).includes('skipped'));
});

test('CI retains an observe-only Entity Certificate B after Host Certificate A', () => {
  const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const hostIndex = workflow.indexOf('npm run certify:host');
  const entityIndex = workflow.indexOf('npm run certify:entity');
  assert.ok(hostIndex >= 0, 'Host Certificate A step exists');
  assert.ok(entityIndex > hostIndex, 'Entity Certificate B runs after Host Certificate A');
  assert.match(workflow, /--host-certificate=artifacts\/host-certificate-a\.json/);
  assert.match(workflow, /name: entity-certificate-b/);
  assert.match(workflow, /path: artifacts\/entity-certificate-b\.json/);
});

test('real PostgreSQL composes every admitted creation path, reset/heal, and the registered mutations', {
  skip: !process.env.DONNA_PG_TEST_URL
}, async () => {
  const receipt = await runEntityCertificateBRealPg({
    pgUrl: process.env.DONNA_PG_TEST_URL,
    hostCertificate: hostCertificate(),
    rootDir: ROOT,
    observedAt: '2026-08-29T14:01:00.000Z'
  });
  assert.equal(receipt.status, 'PASS', JSON.stringify(receipt, null, 2));
  assert.equal(receipt.enforcement, false);
  assert.equal(receipt.product_state_persisted, false);
  assert.deepEqual(receipt.admitted_creation_paths_exercised,
    ['generic_client_route', 'desktop_firm_intake', 'self_provision', 'legacy_heal']);
  assert.ok(receipt.certificates.every(({ status }) => status === 'PASS'));
  assert.ok(receipt.mutation_probes.every(({ detected }) => detected));
  assert.deepEqual(receipt.protected_bf_invariants, [
    'BF1_REAL_PG_SEED_FAILURE',
    'BF2_REAL_PG_LEGAL_FORM',
    'BF3_REAL_PG_FIRM_ISOLATION',
    'BF4_REAL_PG_ACTOR_ATTRIBUTION'
  ]);
  const reset = receipt.certificates.find(({ lifecycle }) => lifecycle === 'reset_recreate');
  assert.equal(reset.status, 'PASS');
  assert.ok(reset.reauthorization_checklist.some(({ kind }) => kind === 'client_capability'));
  assert.ok(reset.reauthorization_checklist.some(({ kind }) => kind === 'reconciliation_authority_grant'));
  const generic = receipt.certificates.filter(({ profile_id }) => profile_id.includes('generic-client-route'));
  assert.equal(generic[1].saga_id, generic[0].saga_id);
  assert.equal(generic[1].entity_dependency_digest, generic[0].entity_dependency_digest);
  assert.equal(generic[1].generation_digest, generic[0].generation_digest);
  assert.equal(generic[1].attempts, 2);
  assert.equal(receipt.mutation_probes.find(({ mutation_id }) => mutation_id === 'gate1b0/admitted-readiness-extension').detected, true);
  assert.equal(receipt.mutation_probes.find(({ mutation_id }) => mutation_id === 'gate1b0/current-generation-business-state').detected, true);
});
