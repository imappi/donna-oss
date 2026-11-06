import { validateWorldSpec } from './worldSchema.js';
import { utcIsoDay } from './utcDay.js';

export const AE_ENTITY_TAX_CONTEXT_VERSION = 'ae.entity-tax-context.v1';

export const AE_WORLD_LEGAL_FORMS = Object.freeze([
  'ae-llc',
  'ae-free-zone-co',
  'ae-sole-establishment',
]);

export const AE_WORLD_ESTABLISHMENT_STANDINGS = Object.freeze(['mainland', 'free_zone']);
export const AE_WORLD_DESIGNATED_ZONE_STATUSES = Object.freeze(['designated', 'not_designated']);
export const AE_WORLD_VAT_REGISTRATION_STATUSES = Object.freeze([
  'registered',
  'not_registered',
  'deregistered',
]);
export const AE_WORLD_VAT_REGISTRATION_SUBJECTS = Object.freeze([
  'legal_entity',
  'natural_person_all_sole_establishments',
]);
export const AE_WORLD_VAT_REGISTRATION_BASES = Object.freeze(['mandatory', 'voluntary', 'other']);
export const AE_WORLD_VAT_THRESHOLD_LIMBS = Object.freeze([
  'preceding_12_months',
  'next_30_days',
]);

const AE_EMIRATE_CODES = new Set(['AUH', 'DXB', 'SHJ', 'AJM', 'UAQ', 'RAK', 'FUJ']);
const ALLOWED_CAPABILITIES = new Set([
  'record_ae_entity_tax_context',
  'assess_ae_vat_registration',
  'reconcile_ae_operating_cash',
  'assess_ae_corporate_tax_period',
  'prepare_ae_vat_period',
  'certify_ae_arabic_pint_evidence',
]);
const PROFILE_PERIOD_OUTCOME_FIELDS = new Set([
  'is_qfzp',
  'qfzp_status',
  'qfzp_eligible',
  'qfzp_outcome',
  'de_minimis_passed',
  'de_minimis_status',
  'sbr_eligible',
  'small_business_relief_eligible',
  'corporate_tax_rate',
  'corporate_tax_outcome',
  'vat_period_outcome',
  'vat_return_outcome',
]);
const PROFILE_THRESHOLD_FIELDS = new Set([
  'threshold_boundary_set',
  'vat_threshold_boundary_set',
  'vat_registration_threshold_boundary_set',
]);

export function validateAeEntityTaxContextWorld(worldSpec) {
  const errors = [];
  const shape = validateWorldSpec(worldSpec);
  if (!shape.ok) {
    for (const message of shape.errors) {
      addError(errors, 'AE_WORLD_SCHEMA_INVALID', 'worldSpec', message);
    }
    return result(errors);
  }

  if (worldSpec.manifest.jurisdiction !== 'AE') {
    addError(errors, 'AE_JURISDICTION_REQUIRED', 'manifest.jurisdiction', 'AE entity-tax facts require jurisdiction AE.');
  }
  if (!ALLOWED_CAPABILITIES.has(worldSpec.manifest.capabilityId)) {
    addError(
      errors,
      'AE_ENTITY_CONTEXT_CAPABILITY_REQUIRED',
      'manifest.capabilityId',
      `Expected one of ${[...ALLOWED_CAPABILITIES].join(' | ')}.`,
    );
  }

  const artifacts = new Map(worldSpec.artifacts.map((artifact) => [artifact.id, artifact]));
  const observationsByArtifact = indexArtifactObservations(worldSpec.observations);
  const policySources = validatePolicySources(worldSpec.policySources, errors);
  const contexts = [];

  for (const [index, entity] of [...worldSpec.entities].sort(compareById).entries()) {
    const path = entity?.id ? `entities.${entity.id}` : `entities[${index}]`;
    if (entity?.legalForm !== worldSpec.manifest.entityType) {
      addError(errors, 'AE_MANIFEST_ENTITY_TYPE_MISMATCH', `${path}.legalForm`, 'The entity legal form must match manifest.entityType.');
    }
    const context = validateEntity({
      entity,
      path,
      onDate: worldSpec.effectiveDate,
      artifacts,
      observationsByArtifact,
      policySources,
      errors,
    });
    if (context) contexts.push(context);
  }

  const thresholdBoundaryCases = validateThresholdBoundarySet({
    boundarySet: worldSpec.thresholdBoundarySet,
    policySources,
    errors,
  });

  return result(errors, { contexts, thresholdBoundaryCases });
}

export function expandAeVatThresholdBoundarySet(boundarySet = {}) {
  const thresholdFils = parseAedToFils(boundarySet.thresholdAed);
  if (thresholdFils === null) return [];
  const deltas = Array.isArray(boundarySet.deltasFils)
    ? [...boundarySet.deltasFils].filter(Number.isSafeInteger).sort((left, right) => left - right)
    : [];
  const requestedLimbs = new Set(Array.isArray(boundarySet.limbs) ? boundarySet.limbs : []);

  return AE_WORLD_VAT_THRESHOLD_LIMBS
    .filter((limb) => requestedLimbs.has(limb))
    .flatMap((limb) => deltas.map((deltaFils) => ({
      caseId: `${limb}/${boundaryLabel(deltaFils)}`,
      limb,
      thresholdAed: formatFils(thresholdFils),
      amountAed: formatFils(thresholdFils + deltaFils),
      deltaFils,
      policySourceId: boundarySet.policySourceId,
    })));
}

function validateEntity({
  entity,
  path,
  onDate,
  artifacts,
  observationsByArtifact,
  policySources,
  errors,
}) {
  if (!isPlainObject(entity)) return null;
  if (!AE_WORLD_LEGAL_FORMS.includes(entity.legalForm)) {
    addError(errors, 'AE_LEGAL_FORM_REQUIRED', `${path}.legalForm`, `Expected one of ${AE_WORLD_LEGAL_FORMS.join(' | ')}.`);
  }
  if (!isIsoDay(entity.activeFrom)) {
    addError(errors, 'AE_ENTITY_ACTIVE_FROM_REQUIRED', `${path}.activeFrom`, 'An ISO activeFrom date is required.');
  }
  if (!isPlainObject(entity.facts)) {
    addError(errors, 'AE_ENTITY_FACTS_REQUIRED', `${path}.facts`, 'AE entity facts must be an object.');
    return null;
  }

  validateForbiddenProfileFields(entity.facts, `${path}.facts`, errors);
  const sourceContext = { onDate, artifacts, observationsByArtifact, policySources, errors };

  const standingRecords = validateTimeline({
    records: entity.facts.freeZoneStanding,
    path: `${path}.facts.freeZoneStanding`,
    requiredCode: 'AE_FREE_ZONE_STANDING_REQUIRED',
    overlapCode: 'AE_FREE_ZONE_STANDING_OVERLAP',
    onDateCode: 'AE_FREE_ZONE_STANDING_NOT_EFFECTIVE',
    onDate,
    errors,
    validateRecord: (record, recordPath) => validateStandingRecord(record, recordPath, entity, sourceContext),
  });
  const designatedRecords = validateTimeline({
    records: entity.facts.designatedZone,
    path: `${path}.facts.designatedZone`,
    requiredCode: 'AE_DESIGNATED_ZONE_REQUIRED',
    overlapCode: 'AE_DESIGNATED_ZONE_OVERLAP',
    onDateCode: 'AE_DESIGNATED_ZONE_NOT_EFFECTIVE',
    onDate,
    errors,
    validateRecord: (record, recordPath) => validateDesignatedZoneRecord(record, recordPath, entity, sourceContext),
  });
  const registrationRecords = validateTimeline({
    records: entity.facts.vatRegistration,
    path: `${path}.facts.vatRegistration`,
    requiredCode: 'AE_VAT_REGISTRATION_REQUIRED',
    overlapCode: 'AE_VAT_REGISTRATION_OVERLAP',
    onDateCode: 'AE_VAT_REGISTRATION_NOT_EFFECTIVE',
    onDate,
    errors,
    validateRecord: (record, recordPath) => validateRegistrationRecord(record, recordPath, entity, sourceContext),
  });

  const activeStanding = activeRecord(standingRecords, onDate);
  const activeDesignated = activeRecord(designatedRecords, onDate);
  const activeRegistration = activeRecord(registrationRecords, onDate);
  validatePlaneConsistency({ entity, path, activeStanding, activeDesignated, errors });

  const ftaVatPeriods = validateFtaVatPeriods({
    periods: entity.facts.ftaVatPeriods,
    path: `${path}.facts.ftaVatPeriods`,
    registrationRecords,
    activeRegistration,
    sourceContext,
  });

  if (!activeStanding || !activeDesignated || !activeRegistration) return null;
  return {
    entityId: entity.id,
    legalForm: entity.legalForm,
    asOf: onDate,
    freeZoneStanding: clone(activeStanding),
    designatedZone: clone(activeDesignated),
    vatRegistration: clone(activeRegistration),
    ftaVatPeriods: ftaVatPeriods.map(clone),
  };
}

function validateStandingRecord(record, path, entity, sourceContext) {
  if (!isPlainObject(record)) {
    addError(sourceContext.errors, 'AE_FREE_ZONE_STANDING_INVALID', path, 'Standing facts must be objects.');
    return;
  }
  if (!AE_WORLD_ESTABLISHMENT_STANDINGS.includes(record.standing)) {
    addError(sourceContext.errors, 'AE_FREE_ZONE_STANDING_INVALID', `${path}.standing`, `Expected ${AE_WORLD_ESTABLISHMENT_STANDINGS.join(' | ')}.`);
  }
  if (typeof record.licensingAuthority !== 'string' || record.licensingAuthority.trim() === '') {
    addError(sourceContext.errors, 'AE_LICENSING_AUTHORITY_REQUIRED', `${path}.licensingAuthority`, 'The licensing authority is a separate required fact.');
  }
  if (!AE_EMIRATE_CODES.has(record.emirate)) {
    addError(sourceContext.errors, 'AE_EMIRATE_REQUIRED', `${path}.emirate`, 'Use one of AUH | DXB | SHJ | AJM | UAQ | RAK | FUJ.');
  }
  if (Object.hasOwn(record, 'designatedZone') || Object.hasOwn(record, 'designatedZoneStatus')) {
    addError(
      sourceContext.errors,
      'AE_DESIGNATED_ZONE_CONFLATED_WITH_STANDING',
      path,
      'Designated-zone status is a separate sourced VAT fact, not an attribute inferred inside free-zone standing.',
    );
  }
  validateFactSource(record, path, sourceContext);
  validateFactNotBeforeEntity(record, path, entity, sourceContext.errors);
}

function validateDesignatedZoneRecord(record, path, entity, sourceContext) {
  if (!isPlainObject(record)) {
    addError(sourceContext.errors, 'AE_DESIGNATED_ZONE_INVALID', path, 'Designated-zone facts must be objects.');
    return;
  }
  if (!AE_WORLD_DESIGNATED_ZONE_STATUSES.includes(record.status)) {
    addError(sourceContext.errors, 'AE_DESIGNATED_ZONE_INVALID', `${path}.status`, `Expected ${AE_WORLD_DESIGNATED_ZONE_STATUSES.join(' | ')}.`);
  }
  if (record.status === 'designated' && (typeof record.zoneName !== 'string' || record.zoneName.trim() === '')) {
    addError(sourceContext.errors, 'AE_DESIGNATED_ZONE_NAME_REQUIRED', `${path}.zoneName`, 'A designated-zone fact must name the listed zone.');
  }
  validateFactSource(record, path, sourceContext, { requirePolicySource: true });
  validateFactNotBeforeEntity(record, path, entity, sourceContext.errors);
}

function validateRegistrationRecord(record, path, entity, sourceContext) {
  if (!isPlainObject(record)) {
    addError(sourceContext.errors, 'AE_VAT_REGISTRATION_INVALID', path, 'VAT-registration facts must be objects.');
    return;
  }
  if (!AE_WORLD_VAT_REGISTRATION_STATUSES.includes(record.status)) {
    addError(sourceContext.errors, 'AE_VAT_REGISTRATION_INVALID', `${path}.status`, `Expected ${AE_WORLD_VAT_REGISTRATION_STATUSES.join(' | ')}.`);
  }
  if (!AE_WORLD_VAT_REGISTRATION_SUBJECTS.includes(record.registrationSubject)) {
    addError(sourceContext.errors, 'AE_VAT_REGISTRATION_SUBJECT_REQUIRED', `${path}.registrationSubject`, 'The registration subject must be explicit.');
  }
  if (typeof record.registrationSubjectId !== 'string' || record.registrationSubjectId.trim() === '') {
    addError(sourceContext.errors, 'AE_VAT_REGISTRATION_SUBJECT_ID_REQUIRED', `${path}.registrationSubjectId`, 'The registration subject needs a stable identity for aggregation and isolation.');
  }
  if (entity.legalForm === 'ae-sole-establishment'
    && record.registrationSubject !== 'natural_person_all_sole_establishments') {
    addError(
      sourceContext.errors,
      'AE_SOLE_ESTABLISHMENT_AGGREGATION_REQUIRED',
      `${path}.registrationSubject`,
      'A natural person\'s sole establishments share one VAT-registration subject and threshold aggregation scope.',
    );
  }
  if (entity.legalForm !== 'ae-sole-establishment' && record.registrationSubject !== 'legal_entity') {
    addError(sourceContext.errors, 'AE_LEGAL_ENTITY_REGISTRATION_SUBJECT_REQUIRED', `${path}.registrationSubject`, 'A company VAT-registration fact must name the legal entity as its subject.');
  }
  if (entity.legalForm !== 'ae-sole-establishment'
    && record.registrationSubjectId !== entity.id) {
    addError(sourceContext.errors, 'AE_LEGAL_ENTITY_REGISTRATION_SUBJECT_ID_INVALID', `${path}.registrationSubjectId`, 'A company registration subject id must equal the entity id.');
  }
  if (entity.legalForm === 'ae-sole-establishment'
    && record.registrationSubjectId === entity.id) {
    addError(sourceContext.errors, 'AE_SOLE_ESTABLISHMENT_OWNER_ID_REQUIRED', `${path}.registrationSubjectId`, 'A sole establishment must key VAT aggregation to its natural-person owner, not its licence/entity id.');
  }
  const trn = String(record.trn || '').replace(/[\s-]/g, '');
  if (record.status === 'registered' && !/^\d{15}$/.test(trn)) {
    addError(sourceContext.errors, 'AE_VAT_TRN_REQUIRED', `${path}.trn`, 'A registered synthetic fact requires a structurally valid 15-digit FTA TRN.');
  }
  if (record.status === 'not_registered' && trn !== '') {
    addError(sourceContext.errors, 'AE_VAT_TRN_FORBIDDEN', `${path}.trn`, 'A not-registered fact cannot carry a stale TRN.');
  }
  if (record.status === 'registered' && !AE_WORLD_VAT_REGISTRATION_BASES.includes(record.registrationBasis)) {
    addError(sourceContext.errors, 'AE_VAT_REGISTRATION_BASIS_REQUIRED', `${path}.registrationBasis`, `Expected ${AE_WORLD_VAT_REGISTRATION_BASES.join(' | ')}.`);
  }
  validateFactSource(record, path, sourceContext);
  validateFactNotBeforeEntity(record, path, entity, sourceContext.errors);
}

function validatePlaneConsistency({ entity, path, activeStanding, activeDesignated, errors }) {
  if (!activeStanding || !activeDesignated) return;
  if (entity.legalForm === 'ae-free-zone-co' && activeStanding.standing !== 'free_zone') {
    addError(errors, 'AE_LEGAL_FORM_STANDING_CONFLICT', `${path}.facts.freeZoneStanding`, 'ae-free-zone-co requires an explicit free_zone standing fact.');
  }
  if (entity.legalForm === 'ae-llc' && activeStanding.standing !== 'mainland') {
    addError(errors, 'AE_LEGAL_FORM_STANDING_CONFLICT', `${path}.facts.freeZoneStanding`, 'ae-llc is the canonical mainland LLC legal form.');
  }
  if (activeDesignated.status === 'designated' && activeStanding.standing !== 'free_zone') {
    addError(errors, 'AE_DESIGNATED_ZONE_REQUIRES_FREE_ZONE', `${path}.facts.designatedZone`, 'Only a separately established free-zone fact can carry designated status.');
  }
}

function validateFtaVatPeriods({ periods, path, registrationRecords, activeRegistration, sourceContext }) {
  const { errors } = sourceContext;
  if (!Array.isArray(periods)) {
    addError(errors, 'AE_FTA_VAT_PERIODS_REQUIRED', path, 'FTA-assigned periods must be an array, even when empty.');
    return [];
  }
  const accepted = [];
  const keys = new Set();
  for (const [index, period] of periods.entries()) {
    const periodPath = period?.periodKey ? `${path}.${period.periodKey}` : `${path}[${index}]`;
    if (!isPlainObject(period)) {
      addError(errors, 'AE_FTA_VAT_PERIOD_INVALID', periodPath, 'FTA-assigned periods must be objects.');
      continue;
    }
    if (typeof period.periodKey !== 'string' || period.periodKey.trim() === '') {
      addError(errors, 'AE_FTA_VAT_PERIOD_KEY_REQUIRED', `${periodPath}.periodKey`, 'The FTA/EmaraTax period key is required.');
    } else if (keys.has(period.periodKey)) {
      addError(errors, 'AE_FTA_VAT_PERIOD_DUPLICATE', `${periodPath}.periodKey`, 'FTA period keys must be unique per entity.');
    }
    keys.add(period.periodKey);
    if (!isIsoDay(period.startsOn) || !isIsoDay(period.endsOn) || !isIsoDay(period.dueOn)
      || period.endsOn < period.startsOn || period.dueOn <= period.endsOn) {
      addError(errors, 'AE_FTA_VAT_PERIOD_DATES_INVALID', periodPath, 'Require ordered ISO dates startsOn <= endsOn < dueOn.');
    }
    if (isIsoDay(period.startsOn) && isIsoDay(period.endsOn)) {
      const registeredInterval = activeRecord(registrationRecords, period.startsOn, 'registered');
      if (!registeredInterval || !isActiveOn(registeredInterval, period.endsOn)) {
        addError(errors, 'AE_FTA_VAT_PERIOD_OUTSIDE_REGISTRATION', periodPath, 'An FTA VAT period must fall wholly within one registered VAT interval.');
      }
    }
    validateFactSource(period, periodPath, sourceContext);
    accepted.push(period);
  }
  const sorted = [...accepted].sort((left, right) => String(left.startsOn).localeCompare(String(right.startsOn)));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].endsOn >= sorted[index].startsOn) {
      addError(errors, 'AE_FTA_VAT_PERIOD_OVERLAP', path, 'FTA-assigned VAT periods must not overlap.');
      break;
    }
  }
  if (activeRegistration?.status === 'registered' && periods.length === 0) {
    addError(
      errors,
      'AE_FTA_VAT_PERIOD_REQUIRED',
      path,
      'A registered world requires an exact FTA-assigned period; cadence alone cannot supply dates or deadlines.',
    );
  }
  return sorted;
}

function validateTimeline({ records, path, requiredCode, overlapCode, onDateCode, onDate, errors, validateRecord }) {
  if (!Array.isArray(records) || records.length === 0) {
    addError(errors, requiredCode, path, 'An explicit effective-dated fact timeline is required.');
    return [];
  }
  for (const [index, record] of records.entries()) {
    const recordPath = `${path}[${index}]`;
    if (!isPlainObject(record)) {
      validateRecord(record, recordPath);
      continue;
    }
    if (!isIsoDay(record.effectiveFrom)) {
      addError(errors, `${requiredCode}_EFFECTIVE_FROM`, `${recordPath}.effectiveFrom`, 'An ISO effectiveFrom date is required.');
    }
    if (record.effectiveTo !== undefined && record.effectiveTo !== null && !isIsoDay(record.effectiveTo)) {
      addError(errors, `${requiredCode}_EFFECTIVE_TO`, `${recordPath}.effectiveTo`, 'effectiveTo must be an ISO date or null.');
    }
    if (isIsoDay(record.effectiveFrom) && isIsoDay(record.effectiveTo) && record.effectiveTo < record.effectiveFrom) {
      addError(errors, `${requiredCode}_INTERVAL_INVALID`, recordPath, 'effectiveTo must not precede effectiveFrom.');
    }
    validateRecord(record, recordPath);
  }
  const sorted = [...records].filter(isPlainObject).sort((left, right) => String(left.effectiveFrom).localeCompare(String(right.effectiveFrom)));
  for (let index = 1; index < sorted.length; index += 1) {
    const previousEnd = sorted[index - 1].effectiveTo;
    if (!isIsoDay(previousEnd) || previousEnd >= sorted[index].effectiveFrom) {
      addError(errors, overlapCode, path, 'Effective-dated facts must not overlap or follow an open-ended predecessor.');
      break;
    }
  }
  const active = sorted.filter((record) => isActiveOn(record, onDate));
  if (active.length !== 1) {
    addError(errors, onDateCode, path, `Exactly one fact must be effective on ${onDate}; found ${active.length}.`);
  }
  return sorted;
}

function validateFactSource(record, path, context, { requirePolicySource = false } = {}) {
  const { onDate, artifacts, observationsByArtifact, policySources, errors } = context;
  if (typeof record.sourceArtifactId !== 'string' || record.sourceArtifactId.trim() === '') {
    addError(errors, 'AE_FACT_SOURCE_ARTIFACT_REQUIRED', `${path}.sourceArtifactId`, 'A source artifact id is required.');
  } else if (!artifacts.has(record.sourceArtifactId)) {
    addError(errors, 'AE_FACT_SOURCE_ARTIFACT_UNKNOWN', `${path}.sourceArtifactId`, `Unknown artifact ${record.sourceArtifactId}.`);
  } else if (!(observationsByArtifact.get(record.sourceArtifactId) || []).some((date) => date <= onDate)) {
    addError(errors, 'AE_FACT_SOURCE_NOT_OBSERVED', `${path}.sourceArtifactId`, `Artifact ${record.sourceArtifactId} was not observed by ${onDate}.`);
  }
  if (requirePolicySource) {
    if (typeof record.policySourceId !== 'string' || record.policySourceId.trim() === '') {
      addError(errors, 'AE_POLICY_SOURCE_REQUIRED', `${path}.policySourceId`, 'A designated-zone fact requires its effective-dated policy source.');
    } else if (!policySources.has(record.policySourceId)) {
      addError(errors, 'AE_POLICY_SOURCE_UNKNOWN', `${path}.policySourceId`, `Unknown policy source ${record.policySourceId}.`);
    }
  }
}

function validateFactNotBeforeEntity(record, path, entity, errors) {
  if (isIsoDay(entity.activeFrom) && isIsoDay(record.effectiveFrom) && record.effectiveFrom < entity.activeFrom) {
    addError(errors, 'AE_FACT_PRECEDES_ENTITY', `${path}.effectiveFrom`, 'An entity fact cannot become effective before the entity is active.');
  }
}

function validateForbiddenProfileFields(value, path, errors) {
  if (!isPlainObject(value) && !Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = snakeCase(key);
    if (PROFILE_PERIOD_OUTCOME_FIELDS.has(normalized)) {
      addError(errors, 'AE_PROFILE_PERIOD_OUTCOME_FORBIDDEN', `${path}.${key}`, 'Per-period VAT/CT/QFZP/SBR outcomes cannot live on the entity profile.');
    }
    if (PROFILE_THRESHOLD_FIELDS.has(normalized)) {
      addError(errors, 'AE_THRESHOLD_BOUNDARY_ON_PROFILE_FORBIDDEN', `${path}.${key}`, 'Threshold observations are dated world facts, not timeless profile facts.');
    }
    validateForbiddenProfileFields(nested, `${path}.${key}`, errors);
  }
}

function validatePolicySources(sources, errors) {
  const index = new Map();
  if (!Array.isArray(sources)) {
    addError(errors, 'AE_POLICY_SOURCES_REQUIRED', 'policySources', 'AE fact worlds require an effective-dated source registry.');
    return index;
  }
  for (const [position, source] of sources.entries()) {
    const path = source?.id ? `policySources.${source.id}` : `policySources[${position}]`;
    if (!isPlainObject(source) || typeof source.id !== 'string' || source.id.trim() === '') {
      addError(errors, 'AE_POLICY_SOURCE_INVALID', path, 'Policy sources require a stable id.');
      continue;
    }
    if (index.has(source.id)) {
      addError(errors, 'AE_POLICY_SOURCE_DUPLICATE', path, `Duplicate policy source ${source.id}.`);
    }
    index.set(source.id, source);
    if (typeof source.authority !== 'string' || source.authority.trim() === '') {
      addError(errors, 'AE_POLICY_SOURCE_AUTHORITY_REQUIRED', `${path}.authority`, 'The issuing authority is required.');
    }
    if (typeof source.url !== 'string' || !/^https:\/\//.test(source.url)) {
      addError(errors, 'AE_POLICY_SOURCE_URL_REQUIRED', `${path}.url`, 'An HTTPS source URL is required.');
    }
    if (!isIsoDay(source.effectiveFrom) || !isIsoDay(source.asOf)) {
      addError(errors, 'AE_POLICY_SOURCE_DATES_REQUIRED', path, 'Policy sources require ISO effectiveFrom and asOf dates.');
    } else if (source.asOf < source.effectiveFrom) {
      addError(errors, 'AE_POLICY_SOURCE_DATES_INVALID', path, 'Policy source asOf must not precede effectiveFrom.');
    }
  }
  return index;
}

function validateThresholdBoundarySet({ boundarySet, policySources, errors }) {
  if (boundarySet === undefined) return [];
  if (!isPlainObject(boundarySet)) {
    addError(errors, 'AE_VAT_THRESHOLD_BOUNDARY_SET_INVALID', 'thresholdBoundarySet', 'Threshold boundaries must be an object.');
    return [];
  }
  if (parseAedToFils(boundarySet.thresholdAed) === null) {
    addError(errors, 'AE_VAT_THRESHOLD_AMOUNT_INVALID', 'thresholdBoundarySet.thresholdAed', 'Use an exact AED decimal with two fils digits.');
  }
  const limbs = Array.isArray(boundarySet.limbs) ? boundarySet.limbs : [];
  if (limbs.length !== AE_WORLD_VAT_THRESHOLD_LIMBS.length
    || AE_WORLD_VAT_THRESHOLD_LIMBS.some((limb) => !limbs.includes(limb))) {
    addError(errors, 'AE_VAT_THRESHOLD_LIMBS_INCOMPLETE', 'thresholdBoundarySet.limbs', 'Both preceding_12_months and next_30_days limbs are required.');
  }
  const deltas = Array.isArray(boundarySet.deltasFils) ? boundarySet.deltasFils : [];
  if (deltas.length !== 3 || ![-1, 0, 1].every((delta) => deltas.includes(delta))) {
    addError(errors, 'AE_VAT_THRESHOLD_BOUNDARIES_INCOMPLETE', 'thresholdBoundarySet.deltasFils', 'Require the exact −1 fils, exact, and +1 fils sensitivity set.');
  }
  if (typeof boundarySet.policySourceId !== 'string' || !policySources.has(boundarySet.policySourceId)) {
    addError(errors, 'AE_VAT_THRESHOLD_POLICY_SOURCE_REQUIRED', 'thresholdBoundarySet.policySourceId', 'The threshold set must reference a registered policy source.');
  }
  for (const field of ['expectedStatus', 'registrationRequired', 'taxOutcome', 'outcome']) {
    if (Object.hasOwn(boundarySet, field)) {
      addError(errors, 'AE_VAT_THRESHOLD_OUTCOME_FORBIDDEN', `thresholdBoundarySet.${field}`, 'AE-1 records threshold facts only; policy outcomes belong to a later independent projection.');
    }
  }
  return expandAeVatThresholdBoundarySet(boundarySet);
}

function parseAedToFils(value) {
  const match = /^(0|[1-9]\d*)\.(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const fils = Number(match[1]) * 100 + Number(match[2]);
  return Number.isSafeInteger(fils) ? fils : null;
}

function formatFils(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

function boundaryLabel(deltaFils) {
  if (deltaFils === -1) return 'minus_one_fils';
  if (deltaFils === 0) return 'exact';
  if (deltaFils === 1) return 'plus_one_fils';
  return `delta_${deltaFils}_fils`;
}

function indexArtifactObservations(observations) {
  const index = new Map();
  for (const observation of observations) {
    if (!observation?.artifactId || !isIsoDay(observation.observedAt)) continue;
    if (!index.has(observation.artifactId)) index.set(observation.artifactId, []);
    index.get(observation.artifactId).push(observation.observedAt);
  }
  return index;
}

function activeRecord(records, onDate, requiredStatus = null) {
  return records.find((record) => isActiveOn(record, onDate) && (requiredStatus === null || record.status === requiredStatus)) || null;
}

function isActiveOn(record, onDate) {
  return isPlainObject(record)
    && isIsoDay(record.effectiveFrom)
    && record.effectiveFrom <= onDate
    && (!isIsoDay(record.effectiveTo) || record.effectiveTo >= onDate);
}

function isIsoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && utcIsoDay(parsed) === value;
}

function snakeCase(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function addError(errors, code, path, message) {
  errors.push({ code, path, message });
}

function result(errors, { contexts = [], thresholdBoundaryCases = [] } = {}) {
  return {
    ok: errors.length === 0,
    version: AE_ENTITY_TAX_CONTEXT_VERSION,
    errors,
    contexts,
    thresholdBoundaryCases,
  };
}

function compareById(left, right) {
  return String(left?.id || '').localeCompare(String(right?.id || ''));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
