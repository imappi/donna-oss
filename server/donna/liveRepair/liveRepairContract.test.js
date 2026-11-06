// DMEM-R1 MX-1 — the live-repair manifest + receipt contract as code
// (docs/design-donna-memory-remediation.md §7.1–§7.4; docs/plan-2026-09-02-memory-remediation-slices.md §5 MX-1).
//
// Pure leaf: no database, no runtime, no live data, no flag. Every fixture here is
// SYNTHETIC — no manifest instance for a real target exists in the tree (LR-* is a
// later wave). The tests pin, one case per refusal the slice names: the closed
// vocabularies, the validators' refusals, the §7.3 completion equation, the §7.4
// erasure balance over the FROZEN copy set, and the canonical-digest rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  OPERATION_CLASSES,
  TARGET_TYPES,
  LOCATOR_KINDS,
  REGISTERED_ACTIONS,
  SEMANTIC_CLASSIFICATIONS,
  MANIFEST_SCHEMA_VERSIONS,
  CONTRACT_ERROR_CODES,
  canonicalJson,
  canonicalDigest,
  manifestDigest,
  withManifestDigest,
  validateLiveRepairManifest
} from './manifestContract.js';
import {
  ACTION_RESULTS,
  PRECONDITION_RESULTS,
  POSTCONDITION_RESULTS,
  COMPENSATION_RESULTS,
  COMPLETION_STATUSES,
  ROLLBACK_STATUSES,
  RECEIPT_SCHEMA_VERSIONS,
  receiptDigest,
  withReceiptDigest,
  completionEquation,
  validateLiveRepairReceipt
} from './receiptContract.js';
import {
  ERASURE_DISPOSITIONS,
  ERASURE_MECHANISMS,
  ERASURE_DISPOSITION_SUMMARIES,
  erasureBalance
} from './erasureResult.js';

const hex = (seed) => createHash('sha256').update(String(seed)).digest('hex');
const clone = (value) => structuredClone(value);

// ---------------------------------------------------------------------------
// Synthetic fixtures (ids are obviously fake; nothing here names a real row)
// ---------------------------------------------------------------------------

const OPERATION_ID = 'op-fixture-live-repair-0001';

function baseRepairManifest() {
  return {
    schema_version: 'live-repair-manifest/1',
    operation_id: OPERATION_ID,
    operation_class: 'LIVE_REPAIR',
    purpose:
      'Fixture: reclassify one synthetic AI-created rule as legacy_ai and repair one synthetic contradictory sent state.',
    created_at: '2026-09-04T08:00:00Z',
    expires_at: '2026-09-05T08:00:00Z',
    target_environment: {
      runtime_profile: 'supervised_desktop_local',
      host_fingerprint: hex('fixture-host'),
      database_oid: '16384',
      database_name: 'donna_fixture',
      object_root: { realpath: '/fixture/object-root', device_id: '16777220' },
      forbidden_targets: ['cloud_database', 'undeclared_object_root']
    },
    authorization_requirement: {
      class: 'LIVE_REPAIR',
      manifest_digest_required: true,
      source_identifier_required_in_receipt: true
    },
    input_baseline: {
      code_revision: '4e20f0b0000000000000000000000000000000000',
      schema_fingerprint: hex('schema'),
      configuration_fingerprint: hex('config'),
      database_snapshot_fingerprint: hex('db-snapshot'),
      object_snapshot_fingerprint: hex('object-snapshot')
    },
    limits: {
      maximum_rows: 2,
      maximum_objects: 0,
      maximum_accounting_amount: { amount: '0', currency: 'not_applicable' },
      locks: ['client_rules', 'evidence_requests'],
      statement_timeout_ms: 5000,
      lock_timeout_ms: 1000,
      canary_duration_ms: 'not_applicable',
      stop_thresholds: [{ metric: 'rows_changed', operator: 'gt', value: 2 }]
    },
    targets: [
      {
        target_id: 'rule-row',
        target_type: 'row',
        locator: {
          kind: 'row',
          table: 'client_rules',
          primary_key: { id: '00000000-0000-4000-8000-000000000001' }
        },
        scope: { tenant: 'fixture-firm', legal_entity: 'fixture-client', subject: 'not_applicable' },
        copy_class_id: 'primary_row.client_rules',
        before: { classification: 'active', digest: hex('rule-before'), version_or_generation: 3 },
        after: { classification: 'legacy_ai', digest_or_predicate: hex('rule-after') },
        required_for_completion: true
      },
      {
        target_id: 'evidence-request-row',
        target_type: 'row',
        locator: {
          kind: 'row',
          table: 'evidence_requests',
          primary_key: { id: '00000000-0000-4000-8000-000000000002' }
        },
        scope: { tenant: 'fixture-firm', legal_entity: 'fixture-client', subject: 'not_applicable' },
        copy_class_id: 'primary_row.evidence_requests',
        before: { classification: 'sent', digest: hex('evidence-before'), version_or_generation: 'gen-7' },
        after: {
          classification: 'not_sent',
          digest_or_predicate: { subject: 'sent_at', operator: 'eq', value: null }
        },
        required_for_completion: true
      }
    ],
    steps: [
      {
        ordinal: 1,
        target_ids: ['rule-row'],
        action: 'row_update',
        preconditions: [{ subject: 'rule-row.digest', operator: 'eq', value: hex('rule-before') }],
        transaction_boundary: 'tx:reclassify-rule',
        idempotency_key: `${OPERATION_ID}:rule-row:1`,
        postconditions: [{ subject: 'rule-row.digest', operator: 'eq', value: hex('rule-after') }],
        external_endpoint_and_action: 'not_applicable',
        indeterminate_outcome_policy: 'reconcile',
        compensation: { action: 'row_update' }
      },
      {
        ordinal: 2,
        target_ids: ['evidence-request-row'],
        action: 'row_update',
        preconditions: [{ subject: 'evidence-request-row.digest', operator: 'eq', value: hex('evidence-before') }],
        transaction_boundary: 'tx:repair-sent-state',
        idempotency_key: `${OPERATION_ID}:evidence-request-row:2`,
        postconditions: [{ subject: 'evidence-request-row.sent_at', operator: 'eq', value: null }],
        external_endpoint_and_action: 'not_applicable',
        indeterminate_outcome_policy: 'stop_for_explicit_resolution',
        compensation: { impossible_with_reason: 'the false sent_at value is not recoverable from any delivery ledger fact' }
      }
    ],
    dry_run: {
      runner_identity_class: 'read_only_inspector',
      output_digest: hex('dry-run'),
      observed_at: '2026-09-04T08:10:00Z',
      passed: true
    },
    recovery: {
      backup_reference: 'snapshot:fixture-0001',
      backup_digest: hex('backup'),
      backup_verified_at: '2026-09-04T08:05:00Z',
      rollback_steps: [{ ordinal: 1, target_ids: ['rule-row'], action: 'row_update' }],
      rollback_postconditions: [{ subject: 'rule-row.digest', operator: 'eq', value: hex('rule-before') }]
    }
  };
}

const repairManifest = () => withManifestDigest(baseRepairManifest());

function baseRepairReceipt(manifest) {
  const environment = manifest.target_environment;
  return {
    schema_version: 'live-repair-receipt/1',
    receipt_id: 'rcpt-fixture-0001',
    operation_id: manifest.operation_id,
    operation_class: manifest.operation_class,
    manifest_digest: manifest.manifest_digest,
    authorization: {
      authorization_receipt_id: 'auth-fixture-0001',
      authorization_class: 'LIVE_REPAIR',
      authorization_source_identifier: 'owner:fixture',
      authorized_manifest_digest: manifest.manifest_digest,
      authorized_at: '2026-09-04T08:20:00Z'
    },
    execution: {
      runner_identity: 'donna-live-runner@fixture',
      started_at: '2026-09-04T08:30:00Z',
      finished_at: '2026-09-04T08:31:00Z',
      target_environment_fingerprint: {
        host_fingerprint: environment.host_fingerprint,
        database_oid: environment.database_oid,
        database_name: environment.database_name,
        object_root: { realpath: environment.object_root.realpath, device_id: environment.object_root.device_id }
      },
      code_revision: manifest.input_baseline.code_revision,
      schema_fingerprint: manifest.input_baseline.schema_fingerprint,
      configuration_fingerprint: manifest.input_baseline.configuration_fingerprint,
      preflight_digest: hex('preflight'),
      dry_run_output_digest: manifest.dry_run.output_digest,
      stop_threshold_events: []
    },
    results: [
      {
        ordinal: 1,
        target_id: 'rule-row',
        attempt_id: `${OPERATION_ID}:rule-row:1`,
        started_at: '2026-09-04T08:30:10Z',
        finished_at: '2026-09-04T08:30:20Z',
        precondition_result: 'passed',
        before_observed: { classification: 'active', digest: hex('rule-before'), version_or_generation: 3 },
        action_result: 'changed',
        transaction_or_provider_reference: 'tx:0001',
        after_observed: { classification: 'legacy_ai', digest: hex('rule-after'), version_or_generation: 4 },
        postcondition_result: 'passed',
        compensation_result: 'not_required',
        proof: { output: 'select digest from client_rules where id = $1 -> 1 row', digest: hex('proof-1') },
        error: null
      },
      {
        ordinal: 2,
        target_id: 'evidence-request-row',
        attempt_id: `${OPERATION_ID}:evidence-request-row:2`,
        started_at: '2026-09-04T08:30:30Z',
        finished_at: '2026-09-04T08:30:40Z',
        precondition_result: 'passed',
        before_observed: { classification: 'sent', digest: hex('evidence-before'), version_or_generation: 'gen-7' },
        action_result: 'changed',
        transaction_or_provider_reference: 'tx:0002',
        after_observed: { classification: 'not_sent', digest: hex('evidence-after'), version_or_generation: 'gen-8' },
        postcondition_result: 'passed',
        compensation_result: 'not_required',
        proof: { output: 'select sent_at from evidence_requests where id = $1 -> null', digest: hex('proof-2') },
        error: null
      }
    ],
    totals: {
      declared_targets: 2,
      result_targets: 2,
      undeclared_targets_touched: 0,
      rows_changed: 2,
      objects_changed: 0,
      accounting_amount_changed_by_currency: {},
      within_manifest_limits: true
    },
    completion: {
      status: 'completed',
      required_target_equation: {
        required_declared: 2,
        verified_changed: 2,
        verified_already_satisfied: 0,
        permitted_held_or_limited: 0,
        unresolved: 0
      },
      equation_balances: true,
      all_required_postconditions_passed: true,
      rollback_status: 'not_required',
      remaining_follow_up: []
    }
  };
}

const repairReceipt = (manifest) => withReceiptDigest(baseRepairReceipt(manifest));

function baseErasureManifest() {
  const manifest = baseRepairManifest();
  manifest.operation_id = 'op-fixture-live-erasure-0001';
  manifest.operation_class = 'LIVE_ERASURE';
  manifest.purpose = 'Fixture: erase one synthetic subject across two frozen copy classes.';
  manifest.authorization_requirement.class = 'LIVE_ERASURE';
  manifest.limits.locks = ['memory_subjects'];
  manifest.targets = [
    {
      target_id: 'subject-row',
      target_type: 'row',
      locator: { kind: 'row', table: 'memory_subjects', primary_key: { id: '00000000-0000-4000-8000-0000000000aa' } },
      scope: { tenant: 'fixture-firm', legal_entity: 'fixture-client', subject: 'subject-fixture-aa' },
      copy_class_id: 'primary_row.memory_subjects',
      before: { classification: 'active', digest: hex('subject-before'), version_or_generation: 1 },
      after: { classification: 'erased', digest_or_predicate: { subject: 'subject-row.exists', operator: 'eq', value: false } },
      required_for_completion: true
    },
    {
      target_id: 'subject-embedding',
      target_type: 'copy_class',
      locator: {
        kind: 'copy_class',
        copy_class_id: 'index.embeddings',
        locator_fields: { subject_id: '00000000-0000-4000-8000-0000000000aa' }
      },
      scope: { tenant: 'fixture-firm', legal_entity: 'fixture-client', subject: 'subject-fixture-aa' },
      copy_class_id: 'index.embeddings',
      before: { classification: 'active', digest: hex('embedding-before'), version_or_generation: 1 },
      after: { classification: 'erased', digest_or_predicate: { subject: 'subject-embedding.count', operator: 'eq', value: 0 } },
      required_for_completion: true
    }
  ];
  manifest.steps = [
    {
      ordinal: 1,
      target_ids: ['subject-row', 'subject-embedding'],
      action: 'copy_class_erase',
      preconditions: [{ subject: 'subject-row.digest', operator: 'eq', value: hex('subject-before') }],
      transaction_boundary: 'tx:erase-subject',
      idempotency_key: 'op-fixture-live-erasure-0001:subject:1',
      postconditions: [{ subject: 'subject-row.exists', operator: 'eq', value: false }],
      external_endpoint_and_action: 'not_applicable',
      indeterminate_outcome_policy: 'stop_for_explicit_resolution',
      compensation: { impossible_with_reason: 'an erasure is not compensated; a restore reapplies the erasure ledger' }
    }
  ];
  manifest.recovery.rollback_steps = [];
  manifest.recovery.rollback_postconditions = [];
  return manifest;
}

const erasureManifest = () => withManifestDigest(baseErasureManifest());

function erasureResultFor(targetId, copyClassId, overrides = {}) {
  return {
    copy_class_id: copyClassId,
    target_id: targetId,
    required_for_completion: true,
    disposition: 'erased',
    mechanism: 'delete',
    verification_digest: hex(`erasure-proof-${targetId}`),
    retention_expiry: 'not_applicable',
    hold_or_limitation_code: null,
    resurrection_fence_verified: true,
    restore_reapplication_verified: true,
    ...overrides
  };
}

function baseErasureReceipt(manifest, { includeEmbedding }) {
  const receipt = baseRepairReceipt(manifest);
  receipt.receipt_id = 'rcpt-fixture-erasure-0001';
  receipt.authorization.authorization_class = 'LIVE_ERASURE';
  receipt.results = [
    {
      ordinal: 1,
      target_id: 'subject-row',
      attempt_id: 'op-fixture-live-erasure-0001:subject:1',
      started_at: '2026-09-04T08:30:10Z',
      finished_at: '2026-09-04T08:30:20Z',
      precondition_result: 'passed',
      before_observed: { classification: 'active', digest: hex('subject-before'), version_or_generation: 1 },
      action_result: 'changed',
      transaction_or_provider_reference: 'tx:0011',
      after_observed: { classification: 'erased', digest: hex('subject-after'), version_or_generation: 2 },
      postcondition_result: 'passed',
      compensation_result: 'not_required',
      proof: { output: 'select count(*) from memory_subjects where id = $1 -> 0', digest: hex('proof-11') },
      error: null,
      erasure_result: erasureResultFor('subject-row', 'primary_row.memory_subjects')
    }
  ];
  if (includeEmbedding) {
    receipt.results.push({
      ordinal: 2,
      target_id: 'subject-embedding',
      attempt_id: 'op-fixture-live-erasure-0001:subject:1',
      started_at: '2026-09-04T08:30:30Z',
      finished_at: '2026-09-04T08:30:40Z',
      precondition_result: 'passed',
      before_observed: { classification: 'active', digest: hex('embedding-before'), version_or_generation: 1 },
      action_result: 'changed',
      transaction_or_provider_reference: 'tx:0012',
      after_observed: { classification: 'erased', digest: hex('embedding-after'), version_or_generation: 2 },
      postcondition_result: 'passed',
      compensation_result: 'not_required',
      proof: { output: 'index scan subject_id = $1 -> 0 vectors', digest: hex('proof-12') },
      error: null,
      erasure_result: erasureResultFor('subject-embedding', 'index.embeddings')
    });
  }
  const resultTargets = receipt.results.length;
  receipt.totals.result_targets = resultTargets;
  receipt.totals.rows_changed = 1;
  receipt.totals.objects_changed = 0;
  if (includeEmbedding) {
    receipt.completion.status = 'completed';
    receipt.completion.required_target_equation = {
      required_declared: 2,
      verified_changed: 2,
      verified_already_satisfied: 0,
      permitted_held_or_limited: 0,
      unresolved: 0
    };
    receipt.completion.equation_balances = true;
    receipt.completion.all_required_postconditions_passed = true;
  } else {
    receipt.completion.status = 'partial';
    receipt.completion.required_target_equation = {
      required_declared: 2,
      verified_changed: 1,
      verified_already_satisfied: 0,
      permitted_held_or_limited: 0,
      unresolved: 1
    };
    receipt.completion.equation_balances = false;
    receipt.completion.all_required_postconditions_passed = false;
    receipt.completion.remaining_follow_up = ['explicit_resolution_required'];
  }
  return receipt;
}

const erasureReceipt = (manifest, options) => withReceiptDigest(baseErasureReceipt(manifest, options));

function expectRefusal(result, path, code) {
  assert.equal(result.ok, false, `expected a refusal at ${path} (${code}); got ok`);
  const hit = result.errors.find((error) => error.path === path && error.code === code);
  assert.ok(hit, `expected { path: ${path}, code: ${code} } in ${JSON.stringify(result.errors)}`);
  for (const error of result.errors) {
    assert.ok(CONTRACT_ERROR_CODES.includes(error.code), `error code ${error.code} is not in the closed list`);
    assert.equal(typeof error.path, 'string');
  }
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

test('the closed vocabularies are frozen arrays and name the six operation classes', () => {
  assert.deepEqual([...OPERATION_CLASSES], [
    'LIVE_CANARY',
    'LIVE_REPAIR',
    'LIVE_ERASURE',
    'OBJECT_RELOCATION',
    'AUTHORITATIVE_CUTOVER',
    'DESTRUCTIVE_CONTRACT'
  ]);
  assert.deepEqual([...TARGET_TYPES], ['row', 'object', 'schema', 'external', 'copy_class']);
  assert.deepEqual([...ACTION_RESULTS], ['changed', 'already_satisfied', 'refused', 'failed', 'indeterminate']);
  assert.deepEqual([...PRECONDITION_RESULTS], ['passed', 'refused']);
  assert.deepEqual([...POSTCONDITION_RESULTS], ['passed', 'failed', 'indeterminate']);
  assert.deepEqual([...COMPENSATION_RESULTS], ['not_required', 'completed', 'failed', 'indeterminate']);
  assert.deepEqual([...COMPLETION_STATUSES], ['completed', 'refused', 'failed', 'partial', 'indeterminate', 'rolled_back']);
  assert.deepEqual([...ROLLBACK_STATUSES], ['not_required', 'completed', 'failed', 'indeterminate']);
  assert.deepEqual([...ERASURE_DISPOSITIONS], [
    'erased',
    'content_free_proof_retained',
    'held',
    'externally_limited',
    'failed',
    'indeterminate'
  ]);
  assert.deepEqual([...ERASURE_MECHANISMS], ['delete', 'redact', 'rekey', 'destroy_key', 'revoke', 'expire', 'provider_request']);
  assert.deepEqual([...ERASURE_DISPOSITION_SUMMARIES], ['erased', 'erased_with_disclosed_limitations', 'erasure_pending']);
  for (const vocabulary of [
    OPERATION_CLASSES, TARGET_TYPES, LOCATOR_KINDS, REGISTERED_ACTIONS, SEMANTIC_CLASSIFICATIONS,
    MANIFEST_SCHEMA_VERSIONS, RECEIPT_SCHEMA_VERSIONS, CONTRACT_ERROR_CODES, ACTION_RESULTS,
    PRECONDITION_RESULTS, POSTCONDITION_RESULTS, COMPENSATION_RESULTS, COMPLETION_STATUSES,
    ROLLBACK_STATUSES, ERASURE_DISPOSITIONS, ERASURE_MECHANISMS, ERASURE_DISPOSITION_SUMMARIES
  ]) {
    assert.ok(Array.isArray(vocabulary) && Object.isFrozen(vocabulary), 'vocabulary must be a frozen array');
    assert.equal(new Set(vocabulary).size, vocabulary.length, 'vocabulary entries are unique');
  }
});

// ---------------------------------------------------------------------------
// The valid pair
// ---------------------------------------------------------------------------

test('a valid LIVE_REPAIR manifest + receipt pair passes both validators and the equation balances', () => {
  const manifest = repairManifest();
  const receipt = repairReceipt(manifest);
  assert.deepEqual(validateLiveRepairManifest(manifest), { ok: true, errors: [] });
  assert.deepEqual(validateLiveRepairReceipt(receipt, manifest), { ok: true, errors: [] });
  const equation = completionEquation(receipt);
  assert.equal(equation.balances, true);
  assert.equal(equation.required_declared, 2);
  assert.equal(equation.verified_changed + equation.verified_already_satisfied + equation.permitted_held_or_limited, 2);
  assert.equal(equation.unresolved, 0);
  // The validators never mutate their input.
  assert.deepEqual(manifest, repairManifest());
  assert.deepEqual(receipt, repairReceipt(repairManifest()));
});

// ---------------------------------------------------------------------------
// Manifest refusals — one per named case
// ---------------------------------------------------------------------------

test('manifest: a missing field is refused', () => {
  const manifest = repairManifest();
  delete manifest.purpose;
  expectRefusal(validateLiveRepairManifest(withManifestDigest(manifest)), 'purpose', 'missing_field');
  const nested = repairManifest();
  delete nested.targets[1].before.digest;
  expectRefusal(validateLiveRepairManifest(withManifestDigest(nested)), 'targets[1].before.digest', 'missing_field');
});

test('manifest: an unknown enum value is refused', () => {
  const manifest = repairManifest();
  manifest.operation_class = 'LIVE_GUESS';
  manifest.authorization_requirement.class = 'LIVE_GUESS';
  expectRefusal(validateLiveRepairManifest(withManifestDigest(manifest)), 'operation_class', 'unknown_enum_value');
  const step = repairManifest();
  step.steps[0].action = 'do_whatever';
  expectRefusal(validateLiveRepairManifest(withManifestDigest(step)), 'steps[0].action', 'unknown_enum_value');
  const target = repairManifest();
  target.targets[0].target_type = 'table';
  expectRefusal(validateLiveRepairManifest(withManifestDigest(target)), 'targets[0].target_type', 'unknown_enum_value');
});

test('manifest: a wildcard, query, glob or prefix locator is refused', () => {
  const wildcard = repairManifest();
  wildcard.targets[0].locator.primary_key.id = '00000000-0000-4000-8000-%';
  expectRefusal(validateLiveRepairManifest(withManifestDigest(wildcard)), 'targets[0].locator.primary_key.id', 'dynamic_locator');

  const query = repairManifest();
  query.targets[0].locator = { kind: 'row', table: 'client_rules', query: "created_by = 'ai'" };
  expectRefusal(validateLiveRepairManifest(withManifestDigest(query)), 'targets[0].locator.query', 'dynamic_locator');

  const glob = repairManifest();
  glob.targets[0].target_type = 'object';
  glob.targets[0].locator = { kind: 'object', root: 'object_root', relpath: 'evidence/demo-*.pdf', content_digest: hex('blob') };
  expectRefusal(validateLiveRepairManifest(withManifestDigest(glob)), 'targets[0].locator.relpath', 'dynamic_locator');

  const prefix = repairManifest();
  prefix.targets[0].target_type = 'object';
  prefix.targets[0].locator = { kind: 'object', root: 'object_root', relpath: 'evidence/demo-firm/', content_digest: hex('blob') };
  expectRefusal(validateLiveRepairManifest(withManifestDigest(prefix)), 'targets[0].locator.relpath', 'dynamic_locator');

  const prefixKey = repairManifest();
  prefixKey.targets[0].locator = { kind: 'row', table: 'documents', prefix: 'demo-firm-' };
  expectRefusal(validateLiveRepairManifest(withManifestDigest(prefixKey)), 'targets[0].locator.prefix', 'dynamic_locator');

  const list = repairManifest();
  list.targets[0].locator.primary_key.id = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003'];
  expectRefusal(validateLiveRepairManifest(withManifestDigest(list)), 'targets[0].locator.primary_key.id', 'dynamic_locator');
});

test('manifest: a step naming an undeclared target is refused', () => {
  const manifest = repairManifest();
  manifest.steps[0].target_ids = ['rule-row', 'ghost-row'];
  expectRefusal(validateLiveRepairManifest(withManifestDigest(manifest)), 'steps[0].target_ids[1]', 'undeclared_target');
  const rollback = repairManifest();
  rollback.recovery.rollback_steps[0].target_ids = ['ghost-row'];
  expectRefusal(validateLiveRepairManifest(withManifestDigest(rollback)), 'recovery.rollback_steps[0].target_ids[0]', 'undeclared_target');
});

test('manifest: non-contiguous ordinals are refused', () => {
  const manifest = repairManifest();
  manifest.steps[1].ordinal = 3;
  expectRefusal(validateLiveRepairManifest(withManifestDigest(manifest)), 'steps[1].ordinal', 'non_contiguous_ordinals');
  const zero = repairManifest();
  zero.steps[0].ordinal = 0;
  expectRefusal(validateLiveRepairManifest(withManifestDigest(zero)), 'steps[0].ordinal', 'non_contiguous_ordinals');
});

test('manifest: a future result, an unknown field, and a stale digest are refused', () => {
  const future = repairManifest();
  future.results = [];
  expectRefusal(validateLiveRepairManifest(withManifestDigest(future)), 'results', 'future_result_in_manifest');

  const unknown = repairManifest();
  unknown.targets[0].nickname = 'the rule';
  expectRefusal(validateLiveRepairManifest(withManifestDigest(unknown)), 'targets[0].nickname', 'unknown_field');

  const stale = repairManifest();
  stale.purpose = `${stale.purpose} (edited after digest)`;
  expectRefusal(validateLiveRepairManifest(stale), 'manifest_digest', 'digest_mismatch');

  const mismatchedClass = repairManifest();
  mismatchedClass.authorization_requirement.class = 'LIVE_CANARY';
  expectRefusal(validateLiveRepairManifest(withManifestDigest(mismatchedClass)), 'authorization_requirement.class', 'class_mismatch');

  const failedDryRun = repairManifest();
  failedDryRun.dry_run.passed = false;
  expectRefusal(validateLiveRepairManifest(withManifestDigest(failedDryRun)), 'dry_run.passed', 'forbidden_value');
});

// ---------------------------------------------------------------------------
// Receipt refusals — one per named case
// ---------------------------------------------------------------------------

test('receipt: a missing field and an unknown enum value are refused', () => {
  const manifest = repairManifest();
  const missing = repairReceipt(manifest);
  delete missing.authorization.authorized_at;
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(missing), manifest), 'authorization.authorized_at', 'missing_field');
  const enumeration = repairReceipt(manifest);
  enumeration.results[0].action_result = 'probably';
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(enumeration), manifest), 'results[0].action_result', 'unknown_enum_value');
  const status = repairReceipt(manifest);
  status.completion.status = 'done';
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(status), manifest), 'completion.status', 'unknown_enum_value');
});

test('receipt: identity and digest fields that do not equal the manifest are refused', () => {
  const manifest = repairManifest();
  const cases = [
    ['operation_id', (r) => { r.operation_id = 'op-other'; }],
    ['operation_class', (r) => { r.operation_class = 'LIVE_CANARY'; }],
    ['manifest_digest', (r) => { r.manifest_digest = hex('other-manifest'); }],
    ['authorization.authorized_manifest_digest', (r) => { r.authorization.authorized_manifest_digest = hex('other-authorized'); }],
    ['execution.dry_run_output_digest', (r) => { r.execution.dry_run_output_digest = hex('other-dry-run'); }]
  ];
  for (const [path, mutate] of cases) {
    const receipt = repairReceipt(manifest);
    mutate(receipt);
    expectRefusal(validateLiveRepairReceipt(withReceiptDigest(receipt), manifest), path, 'manifest_mismatch');
  }
  const authorizationClass = repairReceipt(manifest);
  authorizationClass.authorization.authorization_class = 'LIVE_CANARY';
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(authorizationClass), manifest), 'authorization.authorization_class', 'class_mismatch');
  const stale = repairReceipt(manifest);
  stale.execution.runner_identity = 'someone-else';
  expectRefusal(validateLiveRepairReceipt(stale, manifest), 'receipt_digest', 'digest_mismatch');
});

test('receipt: a result for an undeclared target, and a declared target without a result, are refused', () => {
  const manifest = repairManifest();
  const undeclared = repairReceipt(manifest);
  undeclared.results[1].target_id = 'ghost-row';
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(undeclared), manifest), 'results[1].target_id', 'undeclared_target');
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(undeclared), manifest), 'targets[1]', 'missing_result');

  const missing = repairReceipt(manifest);
  missing.results = [missing.results[0]];
  missing.totals.result_targets = 1;
  missing.completion.status = 'partial';
  missing.completion.required_target_equation = {
    required_declared: 2, verified_changed: 1, verified_already_satisfied: 0, permitted_held_or_limited: 0, unresolved: 1
  };
  missing.completion.equation_balances = false;
  missing.completion.all_required_postconditions_passed = false;
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(missing), manifest), 'targets[1]', 'missing_result');
});

test('receipt: undeclared_targets_touched other than zero is refused', () => {
  const manifest = repairManifest();
  const receipt = repairReceipt(manifest);
  receipt.totals.undeclared_targets_touched = 1;
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(receipt), manifest), 'totals.undeclared_targets_touched', 'undeclared_targets_touched');
});

test('receipt: claiming completed while the §7.3 equation does not balance is refused', () => {
  const manifest = repairManifest();

  // The runner reports a failed postcondition on a required target but still claims completed with the old numbers.
  const lying = repairReceipt(manifest);
  lying.results[1].postcondition_result = 'failed';
  const refused = validateLiveRepairReceipt(withReceiptDigest(lying), manifest);
  expectRefusal(refused, 'completion.status', 'completion_equation_unbalanced');
  expectRefusal(refused, 'completion.required_target_equation.verified_changed', 'completion_equation_unbalanced');
  expectRefusal(refused, 'completion.all_required_postconditions_passed', 'completion_equation_unbalanced');

  // Claimed numbers that do not sum: required_declared ≠ changed + already_satisfied + held + (unresolved = 0).
  const arithmetic = repairReceipt(manifest);
  arithmetic.completion.required_target_equation.verified_changed = 1;
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(arithmetic), manifest), 'completion.status', 'completion_equation_unbalanced');
  assert.equal(completionEquation(withReceiptDigest(arithmetic)).balances, false);

  // Totals that disagree with the results.
  const totals = repairReceipt(manifest);
  totals.totals.declared_targets = 3;
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(totals), manifest), 'totals.declared_targets', 'totals_mismatch');

  // Over the manifest limit while claiming within limits.
  const limits = repairReceipt(manifest);
  limits.totals.rows_changed = 3;
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(limits), manifest), 'totals.within_manifest_limits', 'forbidden_value');

  // An honest partial receipt with the same failed postcondition passes: the contract refuses lies, not failures.
  const honest = repairReceipt(manifest);
  honest.results[1].postcondition_result = 'failed';
  honest.completion.status = 'partial';
  honest.completion.required_target_equation = {
    required_declared: 2, verified_changed: 1, verified_already_satisfied: 0, permitted_held_or_limited: 0, unresolved: 1
  };
  honest.completion.equation_balances = false;
  honest.completion.all_required_postconditions_passed = false;
  honest.completion.remaining_follow_up = ['explicit_resolution_required'];
  assert.deepEqual(validateLiveRepairReceipt(withReceiptDigest(honest), manifest), { ok: true, errors: [] });
  assert.equal(completionEquation(withReceiptDigest(honest)).balances, false);
});

test('receipt: the manifest is validated first and its errors are reported under manifest.', () => {
  const manifest = repairManifest();
  const receipt = repairReceipt(manifest);
  const broken = clone(manifest);
  broken.expires_at = 'tomorrow';
  const result = validateLiveRepairReceipt(receipt, withManifestDigest(broken));
  expectRefusal(result, 'manifest.expires_at', 'invalid_instant');
});

// ---------------------------------------------------------------------------
// LIVE_ERASURE — the balance is over the FROZEN copy set
// ---------------------------------------------------------------------------

test('erasure: a frozen copy_class × target pair with no result leaves the balance open and the subject erasure_pending', () => {
  const manifest = erasureManifest();
  assert.deepEqual(validateLiveRepairManifest(manifest), { ok: true, errors: [] });

  const receipt = erasureReceipt(manifest, { includeEmbedding: false });
  const balance = erasureBalance(receipt, manifest);
  assert.equal(balance.frozen_pairs, 2);
  assert.equal(balance.erased, 1);
  assert.equal(balance.missing, 1);
  assert.equal(balance.unresolved, 1);
  assert.equal(balance.balances, false);
  assert.equal(balance.disposition_summary, 'erasure_pending');
  assert.deepEqual(
    balance.pairs.map((pair) => [pair.copy_class_id, pair.target_id, pair.disposition]),
    [
      ['primary_row.memory_subjects', 'subject-row', 'erased'],
      ['index.embeddings', 'subject-embedding', null]
    ]
  );
  // The honest partial receipt is still refused: every frozen pair must carry a result.
  expectRefusal(validateLiveRepairReceipt(receipt, manifest), 'targets[1]', 'missing_result');

  // A receipt that claims completed on the same evidence is refused on the erasure balance too.
  const claiming = baseErasureReceipt(manifest, { includeEmbedding: false });
  claiming.completion.status = 'completed';
  claiming.completion.equation_balances = true;
  claiming.completion.all_required_postconditions_passed = true;
  claiming.completion.remaining_follow_up = [];
  const refused = validateLiveRepairReceipt(withReceiptDigest(claiming), manifest);
  expectRefusal(refused, 'completion.status', 'erasure_balance_open');
  expectRefusal(refused, 'completion.status', 'completion_equation_unbalanced');
});

test('erasure: the balance closes only when every frozen pair carries a permitted terminal result', () => {
  const manifest = erasureManifest();
  const receipt = erasureReceipt(manifest, { includeEmbedding: true });
  assert.deepEqual(validateLiveRepairReceipt(receipt, manifest), { ok: true, errors: [] });
  const balance = erasureBalance(receipt, manifest);
  assert.equal(balance.balances, true);
  assert.equal(balance.disposition_summary, 'erased');
  assert.deepEqual(balance.limitations, []);

  // The balance is computed over the manifest's frozen set: a result the runner "found" for a
  // pair outside it is refused, never counted.
  const extra = baseErasureReceipt(manifest, { includeEmbedding: true });
  extra.results[1].erasure_result.copy_class_id = 'cache.retrieval';
  const refused = validateLiveRepairReceipt(withReceiptDigest(extra), manifest);
  expectRefusal(refused, 'results[1].erasure_result.copy_class_id', 'undeclared_target');
  const extraBalance = erasureBalance(withReceiptDigest(extra), manifest);
  assert.equal(extraBalance.frozen_pairs, 2);
  assert.equal(extraBalance.missing, 1);
  assert.equal(extraBalance.balances, false);

  // A held pair with a closed limitation code is permitted, disclosed, and never called erased.
  const held = baseErasureReceipt(manifest, { includeEmbedding: true });
  held.results[1].action_result = 'refused';
  held.results[1].after_observed = { classification: 'held', digest: hex('embedding-before'), version_or_generation: 1 };
  held.results[1].erasure_result = erasureResultFor('subject-embedding', 'index.embeddings', {
    disposition: 'held',
    mechanism: 'expire',
    hold_or_limitation_code: 'legal_hold',
    retention_expiry: '2027-01-01T00:00:00Z'
  });
  held.completion.required_target_equation = {
    required_declared: 2, verified_changed: 1, verified_already_satisfied: 0, permitted_held_or_limited: 1, unresolved: 0
  };
  held.completion.remaining_follow_up = ['legal_hold_review'];
  assert.deepEqual(validateLiveRepairReceipt(withReceiptDigest(held), manifest), { ok: true, errors: [] });
  const heldBalance = erasureBalance(withReceiptDigest(held), manifest);
  assert.equal(heldBalance.balances, true);
  assert.equal(heldBalance.permitted_held_or_limited, 1);
  assert.equal(heldBalance.disposition_summary, 'erased_with_disclosed_limitations');
  assert.deepEqual(heldBalance.limitations, [
    { copy_class_id: 'index.embeddings', target_id: 'subject-embedding', disposition: 'held', hold_or_limitation_code: 'legal_hold' }
  ]);

  // A held pair WITHOUT a limitation code is not permitted: unresolved, pending.
  const bareHold = clone(held);
  bareHold.results[1].erasure_result.hold_or_limitation_code = null;
  assert.equal(erasureBalance(withReceiptDigest(bareHold), manifest).disposition_summary, 'erasure_pending');
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(bareHold), manifest), 'completion.status', 'erasure_balance_open');

  // A LIVE_ERASURE manifest target without a copy class, and a result without the extension, are refused.
  const noClass = baseErasureManifest();
  delete noClass.targets[1].copy_class_id;
  expectRefusal(validateLiveRepairManifest(withManifestDigest(noClass)), 'targets[1].copy_class_id', 'missing_field');
  const noExtension = baseErasureReceipt(manifest, { includeEmbedding: true });
  delete noExtension.results[1].erasure_result;
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(noExtension), manifest), 'results[1].erasure_result', 'missing_field');
  // ...and a repair receipt must not carry it.
  const repair = repairManifest();
  const misplaced = baseRepairReceipt(repair);
  misplaced.results[0].erasure_result = erasureResultFor('rule-row', 'primary_row.client_rules');
  expectRefusal(validateLiveRepairReceipt(withReceiptDigest(misplaced), repair), 'results[0].erasure_result', 'unknown_field');
});

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

function reverseKeyOrder(value) {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).reverse()) out[key] = reverseKeyOrder(value[key]);
    return out;
  }
  return value;
}

function leafPaths(value, prefix = []) {
  if (Array.isArray(value)) {
    if (!value.length) return [prefix];
    return value.flatMap((item, index) => leafPaths(item, [...prefix, index]));
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return [prefix];
    return keys.flatMap((key) => leafPaths(value[key], [...prefix, key]));
  }
  return [prefix];
}

function perturbAt(root, path) {
  const copy = clone(root);
  let cursor = copy;
  for (const segment of path.slice(0, -1)) cursor = cursor[segment];
  const last = path[path.length - 1];
  const current = cursor[last];
  if (Array.isArray(current)) cursor[last] = [...current, 'perturbed'];
  else if (current && typeof current === 'object') cursor[last] = { ...current, perturbed: true };
  else if (typeof current === 'string') cursor[last] = `${current}~`;
  else if (typeof current === 'number') cursor[last] = current + 1;
  else if (typeof current === 'boolean') cursor[last] = !current;
  else cursor[last] = 'perturbed';
  return copy;
}

test('canonicalDigest is canonical JSON (sorted keys, no whitespace, UTF-8) hashed with sha256', () => {
  const value = { b: [true, null, 'x', 1.5], a: { z: 'ü', y: [] }, c: {} };
  const canonical = '{"a":{"y":[],"z":"ü"},"b":[true,null,"x",1.5],"c":{}}';
  assert.equal(canonicalJson(value), canonical);
  assert.equal(canonicalDigest(value), createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex'));
  assert.equal(canonicalDigest({ a: 1, b: undefined }), canonicalDigest({ a: 1 }));
  assert.equal(canonicalJson([1, { k: 'v' }]), '[1,{"k":"v"}]');
});

test('the manifest digest is independent of key order and dependent on every field, and excludes itself', () => {
  const manifest = repairManifest();
  const reordered = reverseKeyOrder(manifest);
  assert.notDeepEqual(Object.keys(reordered), Object.keys(manifest));
  assert.equal(manifestDigest(reordered), manifest.manifest_digest);
  assert.equal(validateLiveRepairManifest(reordered).ok, true);

  // manifest_digest covers every field except itself.
  const withoutDigest = clone(manifest);
  delete withoutDigest.manifest_digest;
  assert.equal(canonicalDigest(withoutDigest), manifest.manifest_digest);
  const differentSelf = clone(manifest);
  differentSelf.manifest_digest = hex('anything');
  assert.equal(manifestDigest(differentSelf), manifest.manifest_digest);

  // Every leaf (and every empty collection) moves the digest.
  const paths = leafPaths(withoutDigest);
  assert.ok(paths.length > 100, `expected a rich fixture, got ${paths.length} leaves`);
  const seen = new Set([manifest.manifest_digest]);
  for (const path of paths) {
    const digest = manifestDigest(perturbAt(withoutDigest, path));
    assert.ok(!seen.has(digest), `perturbing ${path.join('.')} did not move the manifest digest`);
    seen.add(digest);
  }
});

test('the receipt digest follows the same rule', () => {
  const manifest = repairManifest();
  const receipt = repairReceipt(manifest);
  assert.equal(receiptDigest(reverseKeyOrder(receipt)), receipt.receipt_digest);
  const withoutDigest = clone(receipt);
  delete withoutDigest.receipt_digest;
  assert.equal(canonicalDigest(withoutDigest), receipt.receipt_digest);
  for (const path of leafPaths(withoutDigest)) {
    assert.notEqual(receiptDigest(perturbAt(withoutDigest, path)), receipt.receipt_digest, `perturbing ${path.join('.')} did not move the receipt digest`);
  }
});

test('the liveRepair leaf imports nothing beyond node:crypto and its siblings', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of ['manifestContract.js', 'receiptContract.js', 'erasureResult.js']) {
    const source = await readFile(path.join(here, file), 'utf8');
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier === 'node:crypto' || /^\.\/(manifestContract|receiptContract|erasureResult)\.js$/.test(specifier),
        `${file} imports ${specifier}`
      );
    }
    assert.ok(!/\bdb\//.test(source), `${file} must not reach server/donna/db/`);
  }
});
