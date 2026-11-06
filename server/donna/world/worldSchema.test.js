import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROOF0_CAPABILITY_MANIFEST,
  WORLD_SPEC_VERSION,
  createProof0WorldSpec,
  createWorldSpec,
  validateCapabilityManifest,
  validateProof0CapabilityManifest,
  validateWorldSpec,
} from './worldSchema.js';

test('Proof 0 capability manifest pins the processor-settlement lane', () => {
  assert.deepEqual(PROOF0_CAPABILITY_MANIFEST, {
    manifestVersion: 'proof0.v1',
    capabilityId: 'reconcile_processor_settlement',
    jurisdiction: 'GB',
    entityType: 'uk_ltd',
    bookBasis: 'management_books',
    scenarioLane: 'processor_settlement_reconciliation',
    accountingView: 'management_books',
    protectedFailures: [
      'fee_as_revenue',
      'untrusted_instruction_followed',
    ],
  });
  assert.deepEqual(validateCapabilityManifest(PROOF0_CAPABILITY_MANIFEST), {
    ok: true,
    errors: [],
  });
  assert.deepEqual(validateProof0CapabilityManifest(PROOF0_CAPABILITY_MANIFEST), {
    ok: true,
    errors: [],
  });
});

test('manifest validation separates structural validity from the frozen Proof 0 scope', () => {
  const missingResult = validateCapabilityManifest({});
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.errors.join('\n'), /capabilityId must be a non-empty string/);

  const differentScope = {
    ...PROOF0_CAPABILITY_MANIFEST,
    manifestVersion: 'ae.entity-context.v1',
    jurisdiction: 'AE',
    entityType: 'ae-llc',
    capabilityId: 'record_ae_entity_tax_context',
  };
  assert.deepEqual(validateCapabilityManifest(differentScope), { ok: true, errors: [] });

  const wrongScopeResult = validateProof0CapabilityManifest({
    ...differentScope,
    bookBasis: 'statutory_accounts',
  });
  assert.equal(wrongScopeResult.ok, false);
  assert.deepEqual(wrongScopeResult.errors, [
    'jurisdiction must be GB for Proof 0',
    'entityType must be uk_ltd for Proof 0',
    'bookBasis must be management_books for Proof 0',
    'capabilityId must be reconcile_processor_settlement for Proof 0',
  ]);
});

test('generic world specs admit a structurally valid AE capability without weakening Proof 0', () => {
  const aeManifest = {
    manifestVersion: 'ae.entity-context.v1',
    capabilityId: 'record_ae_entity_tax_context',
    jurisdiction: 'AE',
    entityType: 'ae-llc',
    bookBasis: 'management_books',
    scenarioLane: 'ae_entity_tax_context',
    accountingView: 'management_books',
    requiredWorldFamilies: ['mainland_entity_context'],
    permittedActions: ['record_context'],
    maximumAuthority: 'observe_only',
    fallback: {
      terminalState: 'blocked',
      responsibleActor: 'owner_or_firm',
      nextPermittedAction: 'request_missing_entity_fact',
    },
    protectedFailures: ['free_zone_planes_conflated'],
  };
  const world = createWorldSpec({
    worldId: 'ae/entity-context/mainland-llc',
    seed: 'ae-entity-context-v1',
    effectiveDate: '2026-08-31',
    manifest: aeManifest,
  });

  assert.equal(world.specVersion, WORLD_SPEC_VERSION);
  assert.notEqual(world.manifest, aeManifest);
  assert.notEqual(world.manifest.protectedFailures, aeManifest.protectedFailures);
  assert.deepEqual(validateWorldSpec(world), { ok: true, errors: [] });

  const proof0ShapedWorld = { ...world, specVersion: 'proof0.world.v1' };
  assert.deepEqual(validateWorldSpec(proof0ShapedWorld).errors, [
    'manifest.jurisdiction must be GB for Proof 0',
    'manifest.entityType must be uk_ltd for Proof 0',
    'manifest.capabilityId must be reconcile_processor_settlement for Proof 0',
  ]);

  assert.deepEqual(validateWorldSpec({ ...world, specVersion: 'donna.world.v999' }).errors, [
    'specVersion donna.world.v999 is not supported',
  ]);

  const incompleteContract = {
    ...world,
    manifest: {
      ...world.manifest,
      requiredWorldFamilies: [],
      permittedActions: [],
      maximumAuthority: '',
      fallback: { terminalState: 'resolved' },
    },
  };
  assert.deepEqual(validateWorldSpec(incompleteContract).errors, [
    'manifest.requiredWorldFamilies must be a non-empty array',
    'manifest.permittedActions must be a non-empty array',
    'manifest.maximumAuthority must be a non-empty string',
    'manifest.fallback.terminalState must be blocked',
    'manifest.fallback.responsibleActor must be a non-empty string',
    'manifest.fallback.nextPermittedAction must be a non-empty string',
  ]);
});

test('createProof0WorldSpec returns deterministic world arrays and manifest copy', () => {
  const entities = [{ id: 'entity/client', kind: 'company' }];
  const events = [{ id: 'event/invoice-issued', kind: 'sales_invoice_issued' }];
  const observations = [{ id: 'observation/invoice-pdf', eventId: 'event/invoice-issued' }];
  const hiddenFacts = [{ id: 'hidden/director-purpose', ownerOnly: true }];
  const artifacts = [{ id: 'artifact/invoice-pdf', trusted: true }];

  const worldSpec = createProof0WorldSpec({
    worldId: 'proof0/processor-settlement',
    seed: 'proof0-seed-001',
    effectiveDate: '2026-08-05',
    entities,
    events,
    observations,
    hiddenFacts,
    artifacts,
  });

  assert.deepEqual(worldSpec, {
    specVersion: 'proof0.world.v1',
    worldId: 'proof0/processor-settlement',
    seed: 'proof0-seed-001',
    effectiveDate: '2026-08-05',
    manifest: PROOF0_CAPABILITY_MANIFEST,
    entities,
    events,
    observations,
    hiddenFacts,
    artifacts,
  });
  assert.notEqual(worldSpec.entities, entities);
  assert.notEqual(worldSpec.manifest, PROOF0_CAPABILITY_MANIFEST);
  assert.deepEqual(validateWorldSpec(worldSpec), { ok: true, errors: [] });
});

test('world validation rejects missing identity fields, arrays, and manifest', () => {
  const result = validateWorldSpec({
    specVersion: 'proof0.world.v1',
    worldId: '',
    seed: 'proof0-seed-001',
    effectiveDate: '2026-08-05',
    entities: [],
    events: 'not-an-array',
    observations: [],
    hiddenFacts: [],
    artifacts: [],
    manifest: { ...PROOF0_CAPABILITY_MANIFEST, protectedFailures: [''] },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    'worldId must be a non-empty string',
    'events must be an array',
    'manifest.protectedFailures entries must be non-empty strings',
  ]);
});

test('correction event kinds require append-only target-bearing shapes', () => {
  const base = createProof0WorldSpec({ worldId: 'slice2/schema', seed: 's', effectiveDate: '2026-08-19' });
  base.events = [{ id: 'event/correction', type: 'owner_correction', legalEntityId: 'entity/client', occurredAt: '2026-08-02', causalParents: [] }];
  const result = validateWorldSpec(base);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('events.event/correction.targetEventId must be a non-empty string'));
  assert.ok(result.errors.includes('events.event/correction.causalParents must include targetEventId'));
  assert.ok(result.errors.includes('events.event/correction.correction must name factKind and correctedValue'));
  assert.ok(result.errors.includes('events.event/correction.targetPeriodState must be open or locked'));
});
