import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  LIFECYCLE_ACTIONS,
  LIFECYCLE_COMPONENTS,
  computeLifecycleReceiptDigest,
  createLifecycleReceipt,
  validateLifecycleReceipt,
} from './lifecycleReceipts.js';
import { buildExpectedClose, ORACLE_SUITE_VERSION, readProof0PolicyPack } from './oracleSuite.js';
import { POLICY_PROJECTION_VERSION, projectPolicy } from './policyProjection.js';
import { WORLD_RENDERER_VERSION, renderWorldArtifacts } from './worldRenderer.js';
import { validateWorldSpec } from './worldSchema.js';
import { validateCausalWorld } from './worldValidity.js';

const ACTION_OUTCOME = { recompile: 'recompiled', rederive: 'rederived', reaudit: 'reaudited', retire: 'retired' };

function lifecycleInput(component, action, overrides = {}) {
  const retired = action === 'retire';
  return {
    receiptId: `lifecycle/${component}/${action}`,
    component,
    action,
    fromVersion: `${component}.v1`,
    toVersion: retired ? null : `${component}.v2`,
    affectedCaseIds: ['case/a'],
    caseDispositions: [{ caseId: 'case/a', outcome: ACTION_OUTCOME[action] }],
    loadBearingDiffs: action === 'reaudit' ? [{ path: 'treatment', before: 'old', after: 'new' }] : [],
    externalReview: action === 'reaudit' ? { reviewerId: 'reviewer/independent', reviewedAt: '2026-08-09', basis: 'blind load-bearing review', disposition: 'approved' } : undefined,
    tombstones: retired ? [{ caseId: 'case/a', reason: 'superseded interpretation', coverageGap: 'family/a no longer covered', retiredVersion: `${component}.v1` }] : [],
    ...(component === 'policy_pack' ? { effectiveDate: '2026-08-09', reauditDisposition: action === 'reaudit' ? 'approved' : 'pending' } : {}),
    ...overrides,
  };
}

test('component/action table yields independently versioned valid receipts', () => {
  for (const component of LIFECYCLE_COMPONENTS) {
    for (const action of LIFECYCLE_ACTIONS) {
      const receipt = createLifecycleReceipt(lifecycleInput(component, action));
      assert.equal(validateLifecycleReceipt(receipt).ok, true, `${component}/${action}`);
      assert.equal(receipt.component, component);
      assert.equal(receipt.action, action);
      assert.notEqual(receipt.fromVersion, undefined);
      assert.notEqual(receipt.toVersion, undefined);
    }
  }
});

test('rejects implicit versions and an opaque component version', () => {
  assert.throws(() => createLifecycleReceipt(lifecycleInput('renderer', 'recompile', { fromVersion: '' })), /fromVersion/);
  assert.throws(() => createLifecycleReceipt(lifecycleInput('renderer', 'recompile', { toVersion: 'renderer.v1' })), /different/);
  assert.throws(() => createLifecycleReceipt(lifecycleInput('harness', 'recompile')), /component/);
});

test('load-bearing changes require an external review receipt', () => {
  assert.throws(() => createLifecycleReceipt(lifecycleInput('oracle', 'rederive', {
    loadBearingDiffs: [{ path: 'expectedEntries', before: 'a', after: 'b' }],
  })), /externalReview/);
});

test('policy changes require an effective date and reaudit disposition', () => {
  assert.throws(() => createLifecycleReceipt(lifecycleInput('policy_pack', 'rederive', { effectiveDate: '' })), /effectiveDate/);
  assert.throws(() => createLifecycleReceipt(lifecycleInput('policy_pack', 'rederive', { reauditDisposition: undefined })), /reauditDisposition/);
});

test('retirement persists one tombstone and coverage gap per affected case', () => {
  assert.throws(() => createLifecycleReceipt(lifecycleInput('corpus', 'retire', { tombstones: [] })), /tombstone/);
  assert.throws(() => createLifecycleReceipt(lifecycleInput('corpus', 'retire', {
    tombstones: [{ caseId: 'case/a', reason: 'retired', coverageGap: '', retiredVersion: 'corpus.v1' }],
  })), /coverageGap/);
  const receipt = createLifecycleReceipt(lifecycleInput('corpus', 'retire'));
  assert.equal(receipt.tombstones[0].caseId, 'case/a');
  assert.equal(receipt.caseDispositions[0].outcome, 'retired');
});

test('no affected case can be silently erased', () => {
  assert.throws(() => createLifecycleReceipt(lifecycleInput('world_schema', 'recompile', {
    affectedCaseIds: ['case/a', 'case/b'],
  })), /case\/b/);
});

test('receipt digest is canonical, deterministic, and tamper evident', () => {
  const first = createLifecycleReceipt(lifecycleInput('renderer', 'recompile'));
  const second = createLifecycleReceipt(lifecycleInput('renderer', 'recompile'));
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest, computeLifecycleReceiptDigest(first));
  const tampered = structuredClone(first);
  tampered.toVersion = 'renderer.v3';
  assert.match(validateLifecycleReceipt(tampered).errors.join('\n'), /digest does not match/);
});

test('composes lifecycle receipts with the full persisted Proof 0 judge world', async () => {
  const world = JSON.parse(await readFile('data/worlds/proof0.json', 'utf8'));
  const policy = await readProof0PolicyPack();
  assert.equal(validateWorldSpec(world).ok, true);
  assert.equal(validateCausalWorld(world).ok, true);
  const projection = projectPolicy(world, policy);
  const rendered = await renderWorldArtifacts(world);
  const expected = buildExpectedClose(world, policy);
  assert.equal(projection.ok, true);
  assert.equal(rendered.ok, true);
  assert.equal(expected.ok, true);

  const versions = {
    world_schema: world.specVersion,
    renderer: rendered.version,
    policy_pack: `${projection.version}/${projection.policyPackVersion}/${policy.effectiveFrom}`,
    oracle: expected.version,
    corpus: 'proof0.corpus.v1',
  };
  assert.equal(projection.version, POLICY_PROJECTION_VERSION);
  assert.equal(rendered.version, WORLD_RENDERER_VERSION);
  assert.equal(expected.version, ORACLE_SUITE_VERSION);

  const receipts = LIFECYCLE_COMPONENTS.map((component) => createLifecycleReceipt(lifecycleInput(component, 'reaudit', {
    receiptId: `lifecycle/proof0/${component}`,
    fromVersion: versions[component],
    toVersion: `${versions[component]}.audited`,
    affectedCaseIds: [world.worldId],
    caseDispositions: [{ caseId: world.worldId, outcome: 'reaudited' }],
    ...(component === 'policy_pack' ? { effectiveDate: policy.effectiveFrom, reauditDisposition: 'approved' } : {}),
  })));
  assert.deepEqual(receipts.map(({ component }) => component), LIFECYCLE_COMPONENTS);
  assert.ok(receipts.every((receipt) => validateLifecycleReceipt(receipt).ok));
});
