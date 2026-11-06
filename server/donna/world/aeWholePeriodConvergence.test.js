import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AE_WHOLE_PERIOD_CONVERGENCE_VERSION,
  buildAe7FailureReceipt,
  evaluateAeArrivalOrderInvariant,
  validateAeWholePeriodConvergenceWorld,
} from './aeWholePeriodConvergence.js';

const PATH = new URL('../../../data/worlds/ae/ae-whole-period-convergence.json', import.meta.url);
const load = async () => JSON.parse(await readFile(PATH, 'utf8'));

test('AE-7 fixture is a causally valid, integration-only contract', async () => {
  const world = await load();
  const validation = validateAeWholePeriodConvergenceWorld(world);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.version, AE_WHOLE_PERIOD_CONVERGENCE_VERSION);
  assert.deepEqual(validation.counts, {
    worldCases: 12,
    mutations: 19,
    arrivalOrders: 4,
    crashBoundaries: 10,
    identityCases: 4,
  });
  assert.equal(world.manifest.maximumAuthority, 'synthetic_offline_certification_only');
});

test('AE-7 refuses an incomplete protected-mutation set', async () => {
  const world = await load();
  world.aeWholePeriod.mutationContracts.pop();
  const validation = validateAeWholePeriodConvergenceWorld(world);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some(({ code }) => code === 'AE7_MUTATION_SET_INCOMPLETE'));
});

test('AE-7 refuses a production-widening authority declaration', async () => {
  const world = await load();
  world.manifest.maximumAuthority = 'production_write';
  const validation = validateAeWholePeriodConvergenceWorld(world);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some(({ code }) => code === 'AE7_AUTHORITY_TOO_WIDE'));
});

test('AE-7 refuses a fixture path outside the AE root', async () => {
  const world = await load();
  world.aeWholePeriod.worldCases[0].path = '../customer-data.json';
  const validation = validateAeWholePeriodConvergenceWorld(world);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some(({ code }) => code === 'AE7_WORLD_CASE_INVALID'));
});

test('arrival invariant accepts the exact four canonical terminal digests', async () => {
  const world = await load();
  const digest = 'a'.repeat(64);
  const receipts = world.aeWholePeriod.arrivalOrders.map((orderName) => ({
    orderName,
    projector: 'reconcileConvergenceState',
    terminalDigest: digest,
  }));
  assert.equal(evaluateAeArrivalOrderInvariant(world, receipts, digest).status, 'PASS');
});

test('arrival invariant catches the earliest changed terminal digest', async () => {
  const world = await load();
  const digest = 'a'.repeat(64);
  const receipts = world.aeWholePeriod.arrivalOrders.map((orderName) => ({
    orderName,
    projector: 'reconcileConvergenceState',
    terminalDigest: digest,
  }));
  receipts[1].terminalDigest = 'b'.repeat(64);
  const evaluated = evaluateAeArrivalOrderInvariant(world, receipts, digest);
  assert.equal(evaluated.status, 'FAIL');
  assert.equal(evaluated.failures[0].code, 'AE7_ARRIVAL_ORDER_DIVERGENCE');
});

test('AE-7 shrink target names failure, earliest divergence, and consequence', async () => {
  const receipt = buildAe7FailureReceipt(await load());
  assert.equal(receipt.failureClass, 'AE7_ARRIVAL_ORDER_DIVERGENCE');
  assert.equal(receipt.earliestObservableDivergence.field, 'terminal_digest');
  assert.equal(receipt.consequence.field, 'terminal_inventory_changed');
});
