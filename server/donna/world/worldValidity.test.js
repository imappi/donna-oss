import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createProof0WorldSpec } from './worldSchema.js';
import { WORLD_VALIDITY_VERSION, validateCausalWorld } from './worldValidity.js';

function validProcessorWorld(overrides = {}) {
  return createProof0WorldSpec({
    worldId: 'proof0/valid-processor-settlement',
    seed: 'proof0-valid-001',
    effectiveDate: '2026-08-05',
    entities: [
      { id: 'entity/client', kind: 'legal_entity', activeFrom: '2026-01-01' },
      { id: 'entity/customer', kind: 'counterparty', activeFrom: '2026-01-01' },
    ],
    events: [
      {
        id: 'event/invoice-issued',
        type: 'sales_invoice_issued',
        legalEntityId: 'entity/client',
        counterpartyId: 'entity/customer',
        occurredAt: '2026-08-01',
        causalParents: [],
        monetaryEffects: { gross: 120, currency: 'EUR' },
        evidenceRefs: ['artifact/invoice'],
      },
      {
        id: 'event/customer-paid',
        type: 'customer_payment',
        legalEntityId: 'entity/client',
        counterpartyId: 'entity/customer',
        occurredAt: '2026-08-03',
        causalParents: ['event/invoice-issued'],
        monetaryEffects: { gross: 120, currency: 'EUR' },
        evidenceRefs: ['artifact/processor-report'],
      },
      {
        id: 'event/processor-settlement',
        type: 'processor_settlement',
        legalEntityId: 'entity/client',
        occurredAt: '2026-08-05',
        causalParents: ['event/customer-paid'],
        monetaryEffects: {
          grossReceipts: 102.35,
          fees: 3.15,
          refunds: 0,
          reserves: 0,
          chargebacks: 0,
          fxGainLoss: 0.8,
          settled: 100,
          currency: 'GBP',
        },
        evidenceRefs: ['artifact/bank-line', 'artifact/processor-report'],
      },
      {
        id: 'event/bank-cash-movement',
        type: 'cash_movement',
        legalEntityId: 'entity/client',
        occurredAt: '2026-08-05',
        causalParents: ['event/processor-settlement'],
        monetaryEffects: { amount: 100, currency: 'GBP' },
        evidenceRefs: ['artifact/bank-line'],
      },
    ],
    observations: [
      { id: 'observation/invoice', eventId: 'event/invoice-issued', artifactId: 'artifact/invoice', observedAt: '2026-08-01' },
      { id: 'observation/bank-line', eventId: 'event/bank-cash-movement', artifactId: 'artifact/bank-line', observedAt: '2026-08-05' },
      { id: 'observation/processor-report', eventId: 'event/processor-settlement', artifactId: 'artifact/processor-report', observedAt: '2026-08-06' },
    ],
    hiddenFacts: [
      { id: 'hidden/director-purpose', kind: 'owner_only_fact', revealAfter: '2026-08-07' },
    ],
    artifacts: [
      { id: 'artifact/invoice', kind: 'invoice_pdf', trusted: true },
      { id: 'artifact/bank-line', kind: 'bank_line', trusted: true },
      { id: 'artifact/processor-report', kind: 'processor_report', trusted: true },
    ],
    ...overrides,
  });
}

test('valid causal processor-settlement world passes the Proof 0 validity gate', () => {
  assert.deepEqual(validateCausalWorld(validProcessorWorld()), {
    ok: true,
    version: WORLD_VALIDITY_VERSION,
    errors: [],
  });
});

test('invalid fixture rejects a cash movement without an economic source parent', async () => {
  const invalidWorld = JSON.parse(await readFile('data/worlds/proof0-invalid-missing-economic-source.json', 'utf8'));

  assert.deepEqual(validateCausalWorld(invalidWorld), {
    ok: false,
    version: WORLD_VALIDITY_VERSION,
    errors: ['events.event/orphan-cash.cash_movement must have an economic source parent'],
  });
});

test('validity gate reports deterministic reference, order, and monetary errors', () => {
  const world = validProcessorWorld({
    events: [
      {
        id: 'event/processor-settlement',
        type: 'processor_settlement',
        legalEntityId: 'entity/missing',
        occurredAt: '2026-08-05',
        causalParents: ['event/future-parent', 'event/missing-parent'],
        monetaryEffects: {
          grossReceipts: 102.35,
          fees: 3.15,
          settled: 100,
          currency: 'GBP',
        },
        evidenceRefs: ['artifact/missing'],
        hiddenFactRefs: ['hidden/missing'],
      },
      {
        id: 'event/future-parent',
        type: 'customer_payment',
        legalEntityId: 'entity/client',
        occurredAt: '2026-08-06',
        causalParents: [],
        monetaryEffects: { gross: 120, currency: 'EUR' },
        evidenceRefs: ['artifact/processor-report'],
      },
    ],
  });

  assert.deepEqual(validateCausalWorld(world).errors, [
    'events.event/processor-settlement.legalEntityId must reference an entity',
    'events.event/processor-settlement.causalParents references missing event event/missing-parent',
    'events.event/processor-settlement.evidenceRefs references missing artifact artifact/missing',
    'events.event/processor-settlement.hiddenFactRefs references missing hidden fact hidden/missing',
    'events.event/processor-settlement.causalParents includes future parent event/future-parent',
    'observations.observation/invoice.eventId references missing event event/invoice-issued',
    'observations.observation/bank-line.eventId references missing event event/bank-cash-movement',
    'events.event/processor-settlement.monetaryEffects.settled must equal gross minus fees/refunds/reserves/chargebacks plus fxGainLoss',
  ]);
});

test('observation schedule cannot reveal hidden facts before their revealAfter date', () => {
  const world = validProcessorWorld({
    observations: [
      { id: 'observation/director-purpose-too-early', hiddenFactRefs: ['hidden/director-purpose'], observedAt: '2026-08-06' },
    ],
  });

  assert.deepEqual(validateCausalWorld(world).errors, [
    'observations.observation/director-purpose-too-early reveals hidden fact hidden/director-purpose before revealAfter',
  ]);
});

test('counterfactual mutation may only change its declared load-bearing fact', () => {
  const world = validProcessorWorld({
    counterfactualMutation: {
      declaredFactId: 'hidden/director-purpose',
      changedFactIds: ['hidden/director-purpose', 'hidden/another-fact'],
    },
  });

  assert.deepEqual(validateCausalWorld(world).errors, [
    'counterfactualMutation.changedFactIds may only include declaredFactId, found hidden/another-fact',
  ]);
});

test('correction history rejects nonexistent targets and non-later causal time', async () => {
  const base = JSON.parse(await readFile('data/worlds/slice2-correction-reopen.json', 'utf8'));
  const missing = structuredClone(base);
  const correction = missing.events.find(({ id }) => id === 'event/owner-correction');
  correction.targetEventId = 'event/not-there';
  correction.causalParents = ['event/not-there'];
  assert.ok(validateCausalWorld(missing).errors.includes('events.event/owner-correction.targetEventId references missing event event/not-there'));

  const outOfOrder = structuredClone(base);
  outOfOrder.events.find(({ id }) => id === 'event/owner-correction').occurredAt = '2026-08-08';
  assert.ok(validateCausalWorld(outOfOrder).errors.includes('events.event/owner-correction.occurredAt must be later than target event event/owner-answer-original'));
});

test('correction/reversal/reopen fixture preserves its complete causal trail', async () => {
  const world = JSON.parse(await readFile('data/worlds/slice2-correction-reopen.json', 'utf8'));
  assert.deepEqual(validateCausalWorld(world), { ok: true, version: WORLD_VALIDITY_VERSION, errors: [] });
  assert.ok(world.events.some(({ id }) => id === 'event/owner-answer-original'));
  assert.ok(world.events.some(({ id }) => id === 'event/entry-posted'));
  assert.ok(world.events.some(({ id }) => id === 'event/period-close'));
});
