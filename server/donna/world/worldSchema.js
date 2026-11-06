export const PROOF0_CAPABILITY_MANIFEST = Object.freeze({
  manifestVersion: 'proof0.v1',
  capabilityId: 'reconcile_processor_settlement',
  jurisdiction: 'GB',
  entityType: 'uk_ltd',
  bookBasis: 'management_books',
  scenarioLane: 'processor_settlement_reconciliation',
  accountingView: 'management_books',
  protectedFailures: Object.freeze([
    'fee_as_revenue',
    'untrusted_instruction_followed',
  ]),
});

export const WORLD_SPEC_VERSION = 'donna.world.v2';
const PROOF0_WORLD_SPEC_VERSION = 'proof0.world.v1';
const SUPPORTED_WORLD_SPEC_VERSIONS = new Set([
  PROOF0_WORLD_SPEC_VERSION,
  WORLD_SPEC_VERSION,
]);

const REQUIRED_MANIFEST_FIELDS = Object.freeze({
  manifestVersion: 'string',
  capabilityId: 'string',
  jurisdiction: 'string',
  entityType: 'string',
  bookBasis: 'string',
  scenarioLane: 'string',
  accountingView: 'string',
});

const REQUIRED_WORLD_ARRAY_FIELDS = Object.freeze([
  'entities',
  'events',
  'observations',
  'hiddenFacts',
  'artifacts',
]);

export const CAUSAL_CORRECTION_EVENT_TYPES = Object.freeze([
  'owner_correction',
  'entry_reversal',
  'case_reopen',
]);

export function validateCapabilityManifest(manifest, { requireExecutableContract = false } = {}) {
  const errors = [];

  if (!isPlainObject(manifest)) {
    return {
      ok: false,
      errors: ['manifest must be an object'],
    };
  }

  for (const [field, type] of Object.entries(REQUIRED_MANIFEST_FIELDS)) {
    if (typeof manifest[field] !== type || manifest[field].trim() === '') {
      errors.push(`${field} must be a non-empty ${type}`);
    }
  }

  if (!Array.isArray(manifest.protectedFailures)) {
    errors.push('protectedFailures must be an array');
  } else {
    for (const failure of manifest.protectedFailures) {
      if (typeof failure !== 'string' || failure.trim() === '') {
        errors.push('protectedFailures entries must be non-empty strings');
        break;
      }
    }
  }
  if (requireExecutableContract) {
    validateExecutableCapabilityContract(manifest, errors);
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateProof0CapabilityManifest(manifest) {
  const result = validateCapabilityManifest(manifest);
  const errors = [...result.errors];

  if (!isPlainObject(manifest)) {
    return { ok: false, errors };
  }
  if (manifest.jurisdiction !== PROOF0_CAPABILITY_MANIFEST.jurisdiction) {
    errors.push('jurisdiction must be GB for Proof 0');
  }
  if (manifest.entityType !== PROOF0_CAPABILITY_MANIFEST.entityType) {
    errors.push('entityType must be uk_ltd for Proof 0');
  }
  if (manifest.bookBasis !== PROOF0_CAPABILITY_MANIFEST.bookBasis) {
    errors.push('bookBasis must be management_books for Proof 0');
  }
  if (manifest.capabilityId !== PROOF0_CAPABILITY_MANIFEST.capabilityId) {
    errors.push('capabilityId must be reconcile_processor_settlement for Proof 0');
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function createWorldSpec({
  specVersion = WORLD_SPEC_VERSION,
  worldId,
  seed,
  effectiveDate,
  manifest,
  entities = [],
  events = [],
  observations = [],
  hiddenFacts = [],
  artifacts = [],
  ...extraFields
} = {}) {
  return {
    specVersion,
    worldId,
    seed,
    effectiveDate,
    manifest: cloneManifest(manifest),
    entities: [...entities],
    events: [...events],
    observations: [...observations],
    hiddenFacts: [...hiddenFacts],
    artifacts: [...artifacts],
    ...extraFields,
  };
}

export function createProof0WorldSpec({
  worldId,
  seed,
  effectiveDate,
  entities = [],
  events = [],
  observations = [],
  hiddenFacts = [],
  artifacts = [],
  manifest = PROOF0_CAPABILITY_MANIFEST,
  ...extraFields
} = {}) {
  return createWorldSpec({
    specVersion: PROOF0_WORLD_SPEC_VERSION,
    worldId,
    seed,
    effectiveDate,
    manifest,
    entities,
    events,
    observations,
    hiddenFacts,
    artifacts,
    ...extraFields,
  });
}

export function validateWorldSpec(worldSpec) {
  const errors = [];

  if (!isPlainObject(worldSpec)) {
    return {
      ok: false,
      errors: ['worldSpec must be an object'],
    };
  }

  for (const field of ['specVersion', 'worldId', 'seed', 'effectiveDate']) {
    if (typeof worldSpec[field] !== 'string' || worldSpec[field].trim() === '') {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (typeof worldSpec.specVersion === 'string'
    && worldSpec.specVersion.trim() !== ''
    && !SUPPORTED_WORLD_SPEC_VERSIONS.has(worldSpec.specVersion)) {
    errors.push(`specVersion ${worldSpec.specVersion} is not supported`);
  }

  for (const field of REQUIRED_WORLD_ARRAY_FIELDS) {
    if (!Array.isArray(worldSpec[field])) {
      errors.push(`${field} must be an array`);
    }
  }

  if (Array.isArray(worldSpec.events)) {
    validateCorrectionEventShapes(worldSpec.events, errors);
  }

  const manifestResult = worldSpec.specVersion === PROOF0_WORLD_SPEC_VERSION
    ? validateProof0CapabilityManifest(worldSpec.manifest)
    : validateCapabilityManifest(worldSpec.manifest, { requireExecutableContract: true });
  if (!manifestResult.ok) {
    errors.push(...manifestResult.errors.map((error) => `manifest.${error}`));
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function validateExecutableCapabilityContract(manifest, errors) {
  for (const field of ['requiredWorldFamilies', 'permittedActions']) {
    if (!Array.isArray(manifest[field]) || manifest[field].length === 0) {
      errors.push(`${field} must be a non-empty array`);
      continue;
    }
    if (manifest[field].some((value) => typeof value !== 'string' || value.trim() === '')) {
      errors.push(`${field} entries must be non-empty strings`);
    }
  }
  if (typeof manifest.maximumAuthority !== 'string' || manifest.maximumAuthority.trim() === '') {
    errors.push('maximumAuthority must be a non-empty string');
  }
  if (!isPlainObject(manifest.fallback)) {
    errors.push('fallback must be an object');
    return;
  }
  if (manifest.fallback.terminalState !== 'blocked') {
    errors.push('fallback.terminalState must be blocked');
  }
  for (const field of ['responsibleActor', 'nextPermittedAction']) {
    if (typeof manifest.fallback[field] !== 'string' || manifest.fallback[field].trim() === '') {
      errors.push(`fallback.${field} must be a non-empty string`);
    }
  }
}

function cloneManifest(manifest) {
  if (!isPlainObject(manifest)) return manifest;
  return {
    ...manifest,
    protectedFailures: Array.isArray(manifest.protectedFailures)
      ? [...manifest.protectedFailures]
      : manifest.protectedFailures,
  };
}

function validateCorrectionEventShapes(events, errors) {
  for (const [index, event] of events.entries()) {
    if (!isPlainObject(event) || !CAUSAL_CORRECTION_EVENT_TYPES.includes(event.type)) continue;
    const path = typeof event.id === 'string' && event.id !== '' ? `events.${event.id}` : `events[${index}]`;
    if (typeof event.targetEventId !== 'string' || event.targetEventId.trim() === '') {
      errors.push(`${path}.targetEventId must be a non-empty string`);
    }
    if (!Array.isArray(event.causalParents) || !event.causalParents.includes(event.targetEventId)) {
      errors.push(`${path}.causalParents must include targetEventId`);
    }
    if (event.type === 'owner_correction') {
      if (!isPlainObject(event.correction) || typeof event.correction.factKind !== 'string'
        || event.correction.factKind.trim() === '' || !Object.hasOwn(event.correction, 'correctedValue')) {
        errors.push(`${path}.correction must name factKind and correctedValue`);
      }
      if (!['open', 'locked'].includes(event.targetPeriodState)) {
        errors.push(`${path}.targetPeriodState must be open or locked`);
      }
      if (event.targetPeriodState === 'locked'
        && (typeof event.adjustmentDate !== 'string' || event.adjustmentDate.trim() === '')) {
        errors.push(`${path}.adjustmentDate is required for a locked-period correction`);
      }
    }
    if (event.type === 'entry_reversal'
      && (typeof event.targetEntryId !== 'string' || event.targetEntryId.trim() === '')) {
      errors.push(`${path}.targetEntryId must be a non-empty string`);
    }
    if (event.type === 'case_reopen'
      && (typeof event.triggerEvidenceRef !== 'string' || event.triggerEvidenceRef.trim() === '')) {
      errors.push(`${path}.triggerEvidenceRef must be a non-empty string`);
    }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
