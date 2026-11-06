import { validateWorldSpec } from './worldSchema.js';

export const WORLD_VALIDITY_VERSION = 'proof0.validity.v1';

export function validateCausalWorld(worldSpec) {
  const errors = [];
  const worldShape = validateWorldSpec(worldSpec);
  if (!worldShape.ok) {
    errors.push(...worldShape.errors.map((error) => `schema.${error}`));
    return validityResult(errors);
  }

  const entityIds = collectUniqueIds(worldSpec.entities, 'entities', errors);
  const eventIds = collectUniqueIds(worldSpec.events, 'events', errors);
  const observationIds = collectUniqueIds(worldSpec.observations, 'observations', errors);
  const artifactIds = collectUniqueIds(worldSpec.artifacts, 'artifacts', errors);
  const hiddenFactIds = collectUniqueIds(worldSpec.hiddenFacts, 'hiddenFacts', errors);

  validateEvents(worldSpec.events, { entityIds, eventIds, artifactIds, hiddenFactIds }, errors);
  validateObservations(worldSpec.observations, { eventIds, artifactIds, hiddenFactIds }, errors);
  validateEntityActivity(worldSpec.events, worldSpec.entities, errors);
  validateProcessorSettlements(worldSpec.events, errors);
  validateCashMovements(worldSpec.events, errors);
  validateHiddenFactObservationTiming(worldSpec.observations, worldSpec.hiddenFacts, errors);
  validateCounterfactualDeclarations(worldSpec, errors);
  validateCorrectionEventHistory(worldSpec.events, { artifactIds }, errors);

  return validityResult(errors);
}

function validateCorrectionEventHistory(events, refs, errors) {
  const eventById = new Map(events.filter(isPlainObject).map((event) => [event.id, event]));
  const causalTypes = new Set(['owner_correction', 'entry_reversal', 'case_reopen']);
  for (const event of events) {
    if (!isPlainObject(event) || !causalTypes.has(event.type)) continue;
    const target = eventById.get(event.targetEventId);
    if (!target) {
      errors.push(`events.${event.id}.targetEventId references missing event ${event.targetEventId}`);
      continue;
    }
    if (isIsoDay(target.occurredAt) && isIsoDay(event.occurredAt) && event.occurredAt <= target.occurredAt) {
      errors.push(`events.${event.id}.occurredAt must be later than target event ${target.id}`);
    }
    if (event.type === 'owner_correction' && !['owner_answer', 'owner_fact'].includes(target.type)) {
      errors.push(`events.${event.id}.targetEventId must reference a supplied owner fact or answer`);
    }
    if (event.type === 'owner_correction' && event.targetPeriodState === 'locked') {
      if (!isIsoDay(event.adjustmentDate)) {
        errors.push(`events.${event.id}.adjustmentDate must be an ISO day for a locked-period correction`);
      } else if (isIsoDay(event.occurredAt) && event.adjustmentDate < event.occurredAt) {
        errors.push(`events.${event.id}.adjustmentDate must not precede the correction`);
      }
    }
    if (event.type === 'entry_reversal' && target.type !== 'entry_posted') {
      errors.push(`events.${event.id}.targetEventId must reference a posted entry event`);
    }
    if (event.type === 'case_reopen' && !['period_close', 'case_settled'].includes(target.type)) {
      errors.push(`events.${event.id}.targetEventId must reference a settled case or period close`);
    }
    if (event.type === 'case_reopen' && !refs.artifactIds.has(event.triggerEvidenceRef)) {
      errors.push(`events.${event.id}.triggerEvidenceRef references missing artifact ${event.triggerEvidenceRef}`);
    }
  }
}

function validityResult(errors) {
  return {
    ok: errors.length === 0,
    version: WORLD_VALIDITY_VERSION,
    errors,
  };
}

function collectUniqueIds(items, fieldName, errors) {
  const ids = new Set();
  for (const [index, item] of items.entries()) {
    if (!isPlainObject(item)) {
      errors.push(`${fieldName}[${index}] must be an object`);
      continue;
    }
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      errors.push(`${fieldName}[${index}].id must be a non-empty string`);
      continue;
    }
    if (ids.has(item.id)) {
      errors.push(`${fieldName}.${item.id} is duplicated`);
      continue;
    }
    ids.add(item.id);
  }
  return ids;
}

function validateEvents(events, refs, errors) {
  for (const [index, event] of events.entries()) {
    if (!isPlainObject(event) || typeof event.id !== 'string') {
      continue;
    }

    if (typeof event.type !== 'string' || event.type.trim() === '') {
      errors.push(`events.${event.id}.type must be a non-empty string`);
    }
    if (!refs.entityIds.has(event.legalEntityId)) {
      errors.push(`events.${event.id}.legalEntityId must reference an entity`);
    }

    for (const parentId of asArray(event.causalParents)) {
      if (!refs.eventIds.has(parentId)) {
        errors.push(`events.${event.id}.causalParents references missing event ${parentId}`);
      }
    }
    for (const evidenceRef of asArray(event.evidenceRefs)) {
      if (!refs.artifactIds.has(evidenceRef)) {
        errors.push(`events.${event.id}.evidenceRefs references missing artifact ${evidenceRef}`);
      }
    }
    for (const hiddenFactRef of asArray(event.hiddenFactRefs)) {
      if (!refs.hiddenFactIds.has(hiddenFactRef)) {
        errors.push(`events.${event.id}.hiddenFactRefs references missing hidden fact ${hiddenFactRef}`);
      }
    }

    if (!isIsoDay(event.occurredAt)) {
      errors.push(`events.${event.id}.occurredAt must be an ISO day`);
    }
    if (event.observationTime !== undefined && !isIsoDay(event.observationTime)) {
      errors.push(`events.${event.id}.observationTime must be an ISO day when present`);
    }
  }

  if (indexAny(events, ({ id }) => id).size === events.length) {
    validateParentOrder(events, errors);
  }
}

function validateParentOrder(events, errors) {
  const eventById = new Map(events.map((event) => [event.id, event]));
  for (const event of events) {
    for (const parentId of asArray(event.causalParents)) {
      const parent = eventById.get(parentId);
      if (parent && isIsoDay(parent.occurredAt) && isIsoDay(event.occurredAt) && parent.occurredAt > event.occurredAt) {
        errors.push(`events.${event.id}.causalParents includes future parent ${parentId}`);
      }
    }
  }
}

function validateObservations(observations, refs, errors) {
  for (const [index, observation] of observations.entries()) {
    if (!isPlainObject(observation) || typeof observation.id !== 'string') {
      continue;
    }
    if (observation.eventId !== undefined && !refs.eventIds.has(observation.eventId)) {
      errors.push(`observations.${observation.id}.eventId references missing event ${observation.eventId}`);
    }
    if (observation.artifactId !== undefined && !refs.artifactIds.has(observation.artifactId)) {
      errors.push(`observations.${observation.id}.artifactId references missing artifact ${observation.artifactId}`);
    }
    for (const hiddenFactRef of asArray(observation.hiddenFactRefs)) {
      if (!refs.hiddenFactIds.has(hiddenFactRef)) {
        errors.push(`observations.${observation.id}.hiddenFactRefs references missing hidden fact ${hiddenFactRef}`);
      }
    }
    if (!isIsoDay(observation.observedAt)) {
      errors.push(`observations.${observation.id}.observedAt must be an ISO day`);
    }
    if (observation.eventId === undefined && observation.artifactId === undefined && asArray(observation.hiddenFactRefs).length === 0) {
      errors.push(`observations.${observation.id} must reference an event, artifact, or hidden fact`);
    }
  }
}

function validateEntityActivity(events, entities, errors) {
  const entityById = new Map(entities.filter(isPlainObject).map((entity) => [entity.id, entity]));
  for (const event of events) {
    if (!isPlainObject(event) || !isIsoDay(event.occurredAt)) {
      continue;
    }
    const entity = entityById.get(event.legalEntityId);
    if (!entity) {
      continue;
    }
    if (isIsoDay(entity.activeFrom) && event.occurredAt < entity.activeFrom) {
      errors.push(`events.${event.id}.legalEntityId is not active at occurredAt`);
    }
    if (isIsoDay(entity.activeTo) && event.occurredAt > entity.activeTo) {
      errors.push(`events.${event.id}.legalEntityId is not active at occurredAt`);
    }
  }
}

function validateProcessorSettlements(events, errors) {
  for (const event of events) {
    if (!isPlainObject(event) || event.type !== 'processor_settlement') {
      continue;
    }
    const effects = event.monetaryEffects;
    if (!isPlainObject(effects)) {
      errors.push(`events.${event.id}.monetaryEffects must describe settlement components`);
      continue;
    }
    const exactMode = [effects.grossReceipts, effects.fees, effects.settled]
      .some((value) => typeof value === 'string');
    const effect = exactMode ? exactMoneyEffect : numericEffect;
    const zero = exactMode ? 0n : 0;
    const grossReceipts = effect(effects.grossReceipts);
    const discounts = effect(effects.discounts, zero);
    const fees = effect(effects.fees);
    const feeVat = effect(effects.feeVat, zero);
    const refunds = effect(effects.refunds, zero);
    const reserves = effect(effects.reserves, zero);
    const chargebacks = effect(effects.chargebacks, zero);
    const reserveReleases = effect(effects.reserveReleases, zero);
    const chargebackReversals = effect(effects.chargebackReversals, zero);
    const fxGainLoss = effect(effects.fxGainLoss, zero);
    const settled = effect(effects.settled);

    if ([grossReceipts, discounts, fees, feeVat, refunds, reserves, chargebacks, reserveReleases, chargebackReversals, fxGainLoss, settled]
      .some((value) => value === null)) {
      errors.push(`events.${event.id}.monetaryEffects must include numeric values or exact two-decimal strings`);
      continue;
    }

    const derivedSettled = grossReceipts - discounts - fees - feeVat - refunds - reserves - chargebacks
      + reserveReleases + chargebackReversals + fxGainLoss;
    const matches = exactMode ? derivedSettled === settled : roundMoney(derivedSettled) === roundMoney(settled);
    if (!matches) {
      const extended = exactMode || [effects.discounts, effects.feeVat, effects.reserveReleases, effects.chargebackReversals]
        .some((value) => value !== undefined && value !== 0);
      errors.push(extended
        ? `events.${event.id}.monetaryEffects.settled must equal gross minus discounts/fees/feeVat/refunds/reserves/chargebacks plus reserveReleases/chargebackReversals/fxGainLoss`
        : `events.${event.id}.monetaryEffects.settled must equal gross minus fees/refunds/reserves/chargebacks plus fxGainLoss`);
    }
  }
}

function validateCashMovements(events, errors) {
  const economicSourceTypes = new Set([
    'sales_invoice_issued',
    'customer_payment',
    'processor_settlement',
    'director_paid_charge',
    'supplier_charge',
    'fx_conversion',
    'own_account_transfer',
    'cheque_received',
    'cheque_bounced',
  ]);
  const eventById = new Map(events.filter(isPlainObject).map((event) => [event.id, event]));

  for (const event of events) {
    if (!isPlainObject(event) || event.type !== 'cash_movement') {
      continue;
    }
    const parents = asArray(event.causalParents);
    const hasEconomicSource = parents.some((parentId) => economicSourceTypes.has(eventById.get(parentId)?.type));
    if (!hasEconomicSource) {
      errors.push(`events.${event.id}.cash_movement must have an economic source parent`);
    }
  }
}

function validateHiddenFactObservationTiming(observations, hiddenFacts, errors) {
  const hiddenFactById = new Map(hiddenFacts.filter(isPlainObject).map((fact) => [fact.id, fact]));
  for (const observation of observations) {
    if (!isPlainObject(observation) || !isIsoDay(observation.observedAt)) {
      continue;
    }
    for (const hiddenFactRef of asArray(observation.hiddenFactRefs)) {
      const fact = hiddenFactById.get(hiddenFactRef);
      if (fact && isIsoDay(fact.revealAfter) && observation.observedAt < fact.revealAfter) {
        errors.push(`observations.${observation.id} reveals hidden fact ${hiddenFactRef} before revealAfter`);
      }
    }
  }
}

function validateCounterfactualDeclarations(worldSpec, errors) {
  if (worldSpec.counterfactualMutation === undefined) {
    return;
  }
  const mutation = worldSpec.counterfactualMutation;
  if (!isPlainObject(mutation)) {
    errors.push('counterfactualMutation must be an object when present');
    return;
  }
  if (typeof mutation.declaredFactId !== 'string' || mutation.declaredFactId.trim() === '') {
    errors.push('counterfactualMutation.declaredFactId must be a non-empty string');
  }
  if (!Array.isArray(mutation.changedFactIds)) {
    errors.push('counterfactualMutation.changedFactIds must be an array');
    return;
  }
  for (const changedFactId of mutation.changedFactIds) {
    if (changedFactId !== mutation.declaredFactId) {
      errors.push(`counterfactualMutation.changedFactIds may only include declaredFactId, found ${changedFactId}`);
    }
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numericEffect(value, defaultValue = null) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function exactMoneyEffect(value, defaultValue = null) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)\.\d{2}$/.test(value)) {
    return null;
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction] = unsigned.split('.');
  const fils = (BigInt(whole) * 100n) + BigInt(fraction);
  return negative ? -fils : fils;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function isIsoDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function indexAny(items, idFor) {
  return new Set(items.filter(isPlainObject).map(idFor).filter((id) => typeof id === 'string' && id !== ''));
}
