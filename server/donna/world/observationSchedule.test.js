import assert from 'node:assert/strict';
import test from 'node:test';

import { createProof0WorldSpec } from './worldSchema.js';
import {
  OBSERVATION_SCHEDULE_VERSION,
  buildObservationSchedule,
  validateObservationSchedule,
  visibleObservationState,
} from './observationSchedule.js';

function observationWorld(overrides = {}) {
  return createProof0WorldSpec({
    worldId: 'proof0/observation-schedule-world',
    seed: 'proof0-observation-001',
    effectiveDate: '2026-08-05',
    entities: [
      { id: 'entity/client', kind: 'legal_entity', activeFrom: '2026-01-01' },
      { id: 'entity/director', kind: 'director', activeFrom: '2026-01-01' },
    ],
    events: [
      {
        id: 'event/bank-line',
        type: 'cash_movement',
        legalEntityId: 'entity/client',
        occurredAt: '2026-08-05',
        causalParents: [],
        monetaryEffects: { amount: 100, currency: 'GBP' },
        evidenceRefs: ['artifact/bank-line'],
      },
      {
        id: 'event/director-paid-charge',
        type: 'director_paid_charge',
        legalEntityId: 'entity/client',
        counterpartyId: 'entity/director',
        occurredAt: '2026-08-04',
        causalParents: [],
        hiddenFactRefs: ['hidden/business-purpose'],
        monetaryEffects: { amount: 24, currency: 'GBP' },
        evidenceRefs: ['artifact/director-card-line'],
      },
    ],
    observations: [
      { id: 'bank-line', eventId: 'event/bank-line', artifactId: 'artifact/bank-line', observedAt: '2026-08-05' },
      { id: 'delayed-receipt', eventId: 'event/director-paid-charge', artifactId: 'artifact/director-receipt', observedAt: '2026-08-08', delayed: true },
      { id: 'owner-purpose-answer', eventId: 'event/director-paid-charge', hiddenFactRefs: ['hidden/business-purpose'], observedAt: '2026-08-09' },
    ],
    hiddenFacts: [
      { id: 'hidden/business-purpose', kind: 'business_purpose', ownerOnly: true, revealAfter: '2026-08-09', value: 'client-meeting-travel' },
    ],
    artifacts: [
      { id: 'artifact/bank-line', kind: 'bank_line', trusted: true },
      { id: 'artifact/director-card-line', kind: 'bank_line', trusted: true },
      { id: 'artifact/director-receipt', kind: 'receipt_pdf', trusted: true },
    ],
    ...overrides,
  });
}

test('buildObservationSchedule returns deterministic observation receipts and owner fact contracts', () => {
  const schedule = buildObservationSchedule(observationWorld());

  assert.equal(schedule.ok, true);
  assert.equal(schedule.version, OBSERVATION_SCHEDULE_VERSION);
  assert.deepEqual(schedule.observations.map(({ id, observedAt, delayed, requiresOwnerFactIds }) => ({ id, observedAt, delayed, requiresOwnerFactIds })), [
    {
      id: 'observation/bank-line/receipt',
      observedAt: '2026-08-05',
      delayed: false,
      requiresOwnerFactIds: [],
    },
    {
      id: 'observation/delayed-receipt/receipt',
      observedAt: '2026-08-08',
      delayed: true,
      requiresOwnerFactIds: [],
    },
    {
      id: 'observation/owner-purpose-answer/receipt',
      observedAt: '2026-08-09',
      delayed: false,
      requiresOwnerFactIds: ['hidden/business-purpose'],
    },
  ]);
  assert.deepEqual(schedule.ownerFactContracts, [
    {
      id: 'owner-fact-contract/hidden/business-purpose',
      hiddenFactId: 'hidden/business-purpose',
      factKind: 'business_purpose',
      requiredFrom: 'owner',
      availableAt: '2026-08-09',
      askId: 'ask/hidden/business-purpose/owner-fact',
      responseShape: {
        kind: 'owner_fact_value',
        hiddenFactId: 'hidden/business-purpose',
        visibleFields: ['hiddenFactId', 'factKind', 'answeredAt'],
      },
      revealsHiddenFactValue: false,
    },
  ]);
});

test('visibleObservationState reveals delayed evidence and owner contracts only at their scheduled times', () => {
  const schedule = buildObservationSchedule(observationWorld());

  assert.deepEqual(visibleObservationState(schedule, '2026-08-05').observations.map(({ observationId }) => observationId), ['bank-line']);
  assert.deepEqual(visibleObservationState(schedule, '2026-08-05').ownerFactContracts, []);
  assert.deepEqual(visibleObservationState(schedule, '2026-08-08').observations.map(({ observationId }) => observationId), ['bank-line', 'delayed-receipt']);
  assert.deepEqual(visibleObservationState(schedule, '2026-08-09').ownerFactContracts.map(({ hiddenFactId }) => hiddenFactId), ['hidden/business-purpose']);
});

test('owner-only fact contract does not leak hidden fact values', () => {
  const schedule = buildObservationSchedule(observationWorld());
  const serialized = JSON.stringify(schedule);

  assert.equal(serialized.includes('client-meeting-travel'), false);
  assert.equal(schedule.ownerFactContracts[0].revealsHiddenFactValue, false);
  assert.deepEqual(schedule.ownerFactContracts[0].responseShape.visibleFields, ['hiddenFactId', 'factKind', 'answeredAt']);
});

test('schedule validation rejects early hidden-fact observation deterministically', () => {
  const schedule = buildObservationSchedule(observationWorld({
    observations: [
      { id: 'too-early-purpose', eventId: 'event/director-paid-charge', hiddenFactRefs: ['hidden/business-purpose'], observedAt: '2026-08-08' },
    ],
  }));

  assert.deepEqual(schedule, {
    ok: false,
    version: OBSERVATION_SCHEDULE_VERSION,
    errors: ['observations.too-early-purpose reveals hidden fact hidden/business-purpose before revealAfter'],
    observations: [],
    ownerFactContracts: [],
    contradictionRecords: [],
    retryRecords: [],
  });
});

test('schedule emits append-only contradiction and bounded retry records', async () => {
  const world = JSON.parse(await (await import('node:fs/promises')).readFile('data/worlds/slice2-delayed-contradiction.json', 'utf8'));
  const schedule = buildObservationSchedule(world);
  assert.equal(schedule.ok, true);
  assert.equal(schedule.contradictionRecords[0].appendOnly, true);
  assert.equal(schedule.contradictionRecords[0].receiptId, 'receipt/contradiction/director-purpose');
  assert.deepEqual(schedule.retryRecords[0].nudgeAfter, ['2026-08-10', '2026-08-11']);
  assert.equal(schedule.retryRecords[0].maxNudges, 2);
});

test('validateObservationSchedule catches malformed schedule receipts without consulting production paths', () => {
  const world = observationWorld();
  const schedule = buildObservationSchedule(world);
  const malformed = {
    ...schedule,
    observations: [{ ...schedule.observations[0], observedAt: '08/05/2026' }],
    ownerFactContracts: [{ ...schedule.ownerFactContracts[0], revealsHiddenFactValue: true }],
  };

  assert.deepEqual(validateObservationSchedule(malformed, world), {
    ok: false,
    errors: [
      'schedule.observations.observation/bank-line/receipt.observedAt must be an ISO day',
      'schedule.ownerFactContracts.owner-fact-contract/hidden/business-purpose must not reveal hidden fact values in the schedule',
    ],
  });
});
