import { validateWorldSpec } from './worldSchema.js';

export const OBSERVATION_SCHEDULE_VERSION = 'slice2.observationSchedule.v2';

export function buildObservationSchedule(worldSpec) {
  const errors = validateObservationInputs(worldSpec);
  if (errors.length > 0) {
    return scheduleResult(errors);
  }

  const hiddenFactById = new Map(worldSpec.hiddenFacts.filter(isPlainObject).map((fact) => [fact.id, fact]));
  const observationRecords = worldSpec.observations.map((observation) => observationRecord(observation, hiddenFactById)).sort(compareObservationRecords);
  const ownerFactContracts = worldSpec.hiddenFacts
    .filter(isPlainObject)
    .filter((fact) => fact.ownerOnly === true || fact.kind === 'owner_only_fact' || fact.kind === 'business_purpose')
    .map(ownerFactContract)
    .sort(compareById);
  const contradictionRecords = worldSpec.observations
    .filter((observation) => typeof observation?.contradictsObservationId === 'string')
    .map((observation) => ({
      id: `contradiction/${observation.id}/receipt`,
      observationId: observation.id,
      contradictsObservationId: observation.contradictsObservationId,
      caseId: observation.caseId,
      observedAt: observation.observedAt,
      reopenEventId: observation.reopenEventId,
      receiptId: observation.contradictionReceiptId,
      appendOnly: true,
    })).sort(compareById);
  const retryRecords = asArray(worldSpec.retryContracts).map((contract) => ({
    id: `retry/${contract.askId}/contract`,
    askId: contract.askId,
    caseId: contract.caseId,
    factClass: contract.factClass,
    deferrableUntil: contract.deferrableUntil,
    nudgeAfter: [...asArray(contract.nudgeAfter)],
    maxNudges: contract.maxNudges,
  })).sort(compareById);

  return {
    ok: true,
    version: OBSERVATION_SCHEDULE_VERSION,
    errors: [],
    observations: observationRecords,
    ownerFactContracts,
    contradictionRecords,
    retryRecords,
  };
}

export function validateObservationSchedule(schedule, worldSpec) {
  const errors = [];
  const worldErrors = validateObservationInputs(worldSpec);
  if (worldErrors.length > 0) {
    errors.push(...worldErrors.map((error) => `world.${error}`));
  }
  if (!isPlainObject(schedule)) {
    errors.push('schedule must be an object');
    return { ok: false, errors };
  }
  if (!Array.isArray(schedule.observations)) {
    errors.push('schedule.observations must be an array');
  }
  if (!Array.isArray(schedule.ownerFactContracts)) {
    errors.push('schedule.ownerFactContracts must be an array');
  }
  if (!Array.isArray(schedule.contradictionRecords)) errors.push('schedule.contradictionRecords must be an array');
  if (!Array.isArray(schedule.retryRecords)) errors.push('schedule.retryRecords must be an array');
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const observationIds = new Set();
  for (const [index, observation] of schedule.observations.entries()) {
    if (!isPlainObject(observation)) {
      errors.push(`schedule.observations[${index}] must be an object`);
      continue;
    }
    if (typeof observation.id !== 'string' || observation.id.trim() === '') {
      errors.push(`schedule.observations[${index}].id must be a non-empty string`);
      continue;
    }
    if (observationIds.has(observation.id)) {
      errors.push(`schedule.observations.${observation.id} is duplicated`);
    }
    observationIds.add(observation.id);
    if (!isIsoDay(observation.observedAt)) {
      errors.push(`schedule.observations.${observation.id}.observedAt must be an ISO day`);
    }
  }

  const contractIds = new Set();
  for (const [index, contract] of schedule.ownerFactContracts.entries()) {
    if (!isPlainObject(contract)) {
      errors.push(`schedule.ownerFactContracts[${index}] must be an object`);
      continue;
    }
    if (typeof contract.id !== 'string' || contract.id.trim() === '') {
      errors.push(`schedule.ownerFactContracts[${index}].id must be a non-empty string`);
      continue;
    }
    if (contractIds.has(contract.id)) {
      errors.push(`schedule.ownerFactContracts.${contract.id} is duplicated`);
    }
    contractIds.add(contract.id);
    if (!isIsoDay(contract.availableAt)) {
      errors.push(`schedule.ownerFactContracts.${contract.id}.availableAt must be an ISO day`);
    }
    if (contract.revealsHiddenFactValue === true) {
      errors.push(`schedule.ownerFactContracts.${contract.id} must not reveal hidden fact values in the schedule`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function visibleObservationState(schedule, asOf) {
  if (!isPlainObject(schedule) || !Array.isArray(schedule.observations) || !Array.isArray(schedule.ownerFactContracts) || !isIsoDay(asOf)) {
    return {
      ok: false,
      version: OBSERVATION_SCHEDULE_VERSION,
      errors: ['schedule and ISO asOf are required'],
      observations: [],
      ownerFactContracts: [],
      contradictionRecords: [],
      retryRecords: [],
    };
  }

  return {
    ok: true,
    version: OBSERVATION_SCHEDULE_VERSION,
    errors: [],
    observations: schedule.observations.filter(({ observedAt }) => observedAt <= asOf).map(publicObservationRecord),
    ownerFactContracts: schedule.ownerFactContracts.filter(({ availableAt }) => availableAt <= asOf).map(publicOwnerFactContract),
    contradictionRecords: schedule.contradictionRecords.filter(({ observedAt }) => observedAt <= asOf).map((record) => ({ ...record })),
    retryRecords: schedule.retryRecords.map((record) => ({ ...record, nudgeAfter: [...record.nudgeAfter] })),
  };
}

function validateObservationInputs(worldSpec) {
  const errors = [];
  const worldResult = validateWorldSpec(worldSpec);
  if (!worldResult.ok) {
    return worldResult.errors;
  }

  const eventIds = new Set(worldSpec.events.filter(isPlainObject).map(({ id }) => id));
  const artifactIds = new Set(worldSpec.artifacts.filter(isPlainObject).map(({ id }) => id));
  const hiddenFactById = new Map(worldSpec.hiddenFacts.filter(isPlainObject).map((fact) => [fact.id, fact]));
  const observationIds = new Set(worldSpec.observations.filter(isPlainObject).map(({ id }) => id));
  const eventById = new Map(worldSpec.events.filter(isPlainObject).map((event) => [event.id, event]));

  for (const observation of worldSpec.observations) {
    if (!isPlainObject(observation) || typeof observation.id !== 'string') {
      continue;
    }
    if (!isIsoDay(observation.observedAt)) {
      errors.push(`observations.${observation.id}.observedAt must be an ISO day`);
    }
    if (observation.eventId !== undefined && !eventIds.has(observation.eventId)) {
      errors.push(`observations.${observation.id}.eventId references missing event ${observation.eventId}`);
    }
    if (observation.artifactId !== undefined && !artifactIds.has(observation.artifactId)) {
      errors.push(`observations.${observation.id}.artifactId references missing artifact ${observation.artifactId}`);
    }
    for (const hiddenFactId of asArray(observation.hiddenFactRefs)) {
      const hiddenFact = hiddenFactById.get(hiddenFactId);
      if (!hiddenFact) {
        errors.push(`observations.${observation.id}.hiddenFactRefs references missing hidden fact ${hiddenFactId}`);
        continue;
      }
      if (isIsoDay(hiddenFact.revealAfter) && observation.observedAt < hiddenFact.revealAfter) {
        errors.push(`observations.${observation.id} reveals hidden fact ${hiddenFactId} before revealAfter`);
      }
    }
    if (observation.contradictsObservationId !== undefined) {
      if (!observationIds.has(observation.contradictsObservationId)) errors.push(`observations.${observation.id}.contradictsObservationId references missing observation ${observation.contradictsObservationId}`);
      if (observation.contradictsObservationId === observation.id) errors.push(`observations.${observation.id} cannot contradict itself`);
      if (typeof observation.caseId !== 'string' || observation.caseId === '') errors.push(`observations.${observation.id}.caseId is required for a contradiction`);
      const reopen = eventById.get(observation.reopenEventId);
      if (reopen?.type !== 'case_reopen') errors.push(`observations.${observation.id}.reopenEventId must reference a case_reopen event`);
      if (typeof observation.contradictionReceiptId !== 'string' || observation.contradictionReceiptId === '') errors.push(`observations.${observation.id}.contradictionReceiptId is required`);
    }
  }

  for (const contract of asArray(worldSpec.retryContracts)) {
    if (!isPlainObject(contract) || typeof contract.askId !== 'string' || contract.askId === '') errors.push('retryContracts.askId is required');
    if (!isIsoDay(contract?.deferrableUntil)) errors.push(`retryContracts.${contract?.askId ?? '<missing>'}.deferrableUntil must be an ISO day`);
    if (!Number.isSafeInteger(contract?.maxNudges) || contract.maxNudges < 0) errors.push(`retryContracts.${contract?.askId ?? '<missing>'}.maxNudges must be a non-negative integer`);
    const dates = asArray(contract?.nudgeAfter);
    if (dates.some((date) => !isIsoDay(date) || date <= contract.deferrableUntil)) errors.push(`retryContracts.${contract?.askId ?? '<missing>'}.nudgeAfter must be ISO days after deferrableUntil`);
    if (new Set(dates).size !== dates.length || dates.length > (contract?.maxNudges ?? -1)) errors.push(`retryContracts.${contract?.askId ?? '<missing>'}.nudgeAfter exceeds or duplicates its nudge allowance`);
  }

  return errors;
}

function observationRecord(observation, hiddenFactById) {
  const hiddenFactRefs = asArray(observation.hiddenFactRefs);
  const requiresOwnerFactIds = hiddenFactRefs.filter((hiddenFactId) => {
    const hiddenFact = hiddenFactById.get(hiddenFactId);
    return hiddenFact && (hiddenFact.ownerOnly === true || hiddenFact.kind === 'owner_only_fact' || hiddenFact.kind === 'business_purpose');
  });

  return {
    id: `observation/${observation.id}/receipt`,
    observationId: observation.id,
    observedAt: observation.observedAt,
    eventId: observation.eventId ?? null,
    artifactId: observation.artifactId ?? null,
    visibleTo: 'donna',
    delayed: observation.delayed === true,
    trustClass: observation.trustClass ?? 'trusted_evidence',
    requiresOwnerFactIds,
  };
}

function ownerFactContract(hiddenFact) {
  const availableAt = hiddenFact.revealAfter ?? hiddenFact.availableAt;
  return {
    id: `owner-fact-contract/${hiddenFact.id}`,
    hiddenFactId: hiddenFact.id,
    factKind: hiddenFact.kind,
    requiredFrom: 'owner',
    availableAt,
    askId: `ask/${hiddenFact.id}/owner-fact`,
    responseShape: {
      kind: 'owner_fact_value',
      hiddenFactId: hiddenFact.id,
      visibleFields: ['hiddenFactId', 'factKind', 'answeredAt'],
    },
    revealsHiddenFactValue: false,
  };
}

function publicObservationRecord(record) {
  return {
    id: record.id,
    observationId: record.observationId,
    observedAt: record.observedAt,
    eventId: record.eventId,
    artifactId: record.artifactId,
    visibleTo: record.visibleTo,
    delayed: record.delayed,
    trustClass: record.trustClass,
    requiresOwnerFactIds: [...record.requiresOwnerFactIds],
  };
}

function publicOwnerFactContract(contract) {
  return {
    id: contract.id,
    hiddenFactId: contract.hiddenFactId,
    factKind: contract.factKind,
    requiredFrom: contract.requiredFrom,
    availableAt: contract.availableAt,
    askId: contract.askId,
    responseShape: {
      kind: contract.responseShape.kind,
      hiddenFactId: contract.responseShape.hiddenFactId,
      visibleFields: [...contract.responseShape.visibleFields],
    },
    revealsHiddenFactValue: false,
  };
}

function scheduleResult(errors) {
  return {
    ok: false,
    version: OBSERVATION_SCHEDULE_VERSION,
    errors,
    observations: [],
    ownerFactContracts: [],
    contradictionRecords: [],
    retryRecords: [],
  };
}

function compareObservationRecords(left, right) {
  return left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id);
}

function compareById(left, right) {
  return left.id.localeCompare(right.id);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isIsoDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
