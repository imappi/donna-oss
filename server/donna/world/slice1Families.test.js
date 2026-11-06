import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createLifecycleReceipt, LIFECYCLE_COMPONENTS, validateLifecycleReceipt } from './lifecycleReceipts.js';
import { buildObservationSchedule, validateObservationSchedule } from './observationSchedule.js';
import { buildExpectedClose, readProof0PolicyPack } from './oracleSuite.js';
import { projectPolicy } from './policyProjection.js';
import { deriveSiblingWorld } from './siblingWorld.js';
import { renderWorldArtifacts } from './worldRenderer.js';
import { validateWorldSpec } from './worldSchema.js';
import { validateCausalWorld } from './worldValidity.js';

const PATHS = [
  'data/worlds/slice1-gross-to-net-single.json',
  'data/worlds/slice1-batched-fx-fee-netted.json',
  'data/worlds/slice1-director-purpose-close.json',
];
const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const load = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function judge(world, policy) {
  assert.equal(validateWorldSpec(world).ok, true, world.worldId);
  assert.equal(validateCausalWorld(world).ok, true, world.worldId);
  const schedule = buildObservationSchedule(world);
  assert.equal(schedule.ok, true, world.worldId);
  assert.equal(validateObservationSchedule(schedule, world).ok, true, world.worldId);
  const projection = projectPolicy(world, policy);
  const expected = buildExpectedClose(world, policy);
  assert.equal(projection.ok, true, world.worldId);
  assert.equal(expected.ok, true, world.worldId);
  const firstRender = await renderWorldArtifacts(world);
  const secondRender = await renderWorldArtifacts(world);
  assert.equal(firstRender.ok, true, world.worldId);
  assert.deepEqual(firstRender.receipts, secondRender.receipts, world.worldId);
  assert.equal(digest(world), digest(structuredClone(world)), world.worldId);
  return { schedule, projection, expected, rendered: firstRender };
}

test('each Slice 1 family independently executes through the judge stack deterministically', async () => {
  const policy = await readProof0PolicyPack();
  for (const path of PATHS) await judge(await load(path), policy);
});

test('each family receives independently versioned lifecycle evidence', async () => {
  const policy = await readProof0PolicyPack();
  for (const path of PATHS) {
    const world = await load(path);
    const judged = await judge(world, policy);
    const versions = {
      world_schema: world.specVersion,
      renderer: judged.rendered.version,
      policy_pack: `${judged.projection.version}/${judged.projection.policyPackVersion}/${policy.effectiveFrom}`,
      oracle: judged.expected.version,
      corpus: 'slice1.family-corpus.v1',
    };
    const receipts = LIFECYCLE_COMPONENTS.map((component) => createLifecycleReceipt({
      receiptId: `lifecycle/${world.worldId}/${component}`,
      component,
      action: 'recompile',
      fromVersion: versions[component],
      toVersion: `${versions[component]}.slice1-family-audit`,
      affectedCaseIds: [world.worldId],
      caseDispositions: [{ caseId: world.worldId, outcome: 'recompiled' }],
      loadBearingDiffs: [],
      tombstones: [],
      ...(component === 'policy_pack' ? { effectiveDate: policy.effectiveFrom, reauditDisposition: 'not_required' } : {}),
    }));
    assert.equal(receipts.length, 5);
    assert.ok(receipts.every((receipt) => validateLifecycleReceipt(receipt).ok));
    assert.equal(new Set(receipts.map(({ digest: receiptDigest }) => receiptDigest)).size, 5);
  }
});

test('families share one bounded capability but carry distinct causal structure', async () => {
  const worlds = await Promise.all(PATHS.map(load));
  assert.deepEqual(new Set(worlds.map(({ manifest }) => manifest.capabilityId)), new Set(['reconcile_processor_settlement']));
  const eventShapes = worlds.map(({ events }) => events.map(({ type }) => type).sort().join('|'));
  assert.equal(new Set(eventShapes).size, 3);
  assert.deepEqual(worlds.map(({ events }) => events.filter(({ type }) => type === 'processor_settlement').length), [1, 1, 1]);
  assert.deepEqual(worlds.map(({ events }) => events.some(({ type }) => type === 'fx_conversion')), [false, true, true]);
  assert.deepEqual(worlds.map(({ events }) => events.some(({ type }) => type === 'director_paid_charge')), [false, false, true]);
});

test('S1-F3 declared purpose sibling discriminates treatment without changing other facts', async () => {
  const policy = await readProof0PolicyPack();
  const base = await load(PATHS[2]);
  const derived = deriveSiblingWorld(base);
  assert.equal(derived.ok, true);
  const baseExpected = buildExpectedClose(base, policy);
  const siblingExpected = buildExpectedClose(derived.world, policy);
  const purpose = (expected) => expected.expectedEntries.find(({ eventId }) => eventId === 'event/director-charge');
  assert.equal(purpose(baseExpected).treatment, 'travel_expense');
  assert.equal(purpose(siblingExpected).treatment, 'director_loan_account');
  const normalizedSibling = structuredClone(derived.world);
  normalizedSibling.worldId = base.worldId;
  normalizedSibling.hiddenFacts = structuredClone(base.hiddenFacts);
  assert.deepEqual(normalizedSibling, base);
});
