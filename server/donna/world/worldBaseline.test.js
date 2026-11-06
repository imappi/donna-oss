import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  WORLD_BASELINE_ROOT, WORLD_BASELINE_VERSION, baselinePath,
  compareWorldBaseline, computeWorldBaselineDigest, loadWorldBaseline,
  saveWorldBaseline, validateWorldBaseline,
} from './worldBaseline.js';

const HEX = 'a'.repeat(64);

function valid(overrides = {}) {
  const receipt = {
    version: WORLD_BASELINE_VERSION,
    suiteId: 'slice1', capabilityId: 'processor-close', familyId: 'gross-to-net', worldId: 'world-1',
    lifecycle: { worldSchema: 'v1', renderer: 'v1', policyPack: 'gb-v1@2026-04-01', oracle: 'v2', corpus: 'slice1-v1' },
    solverDigest: HEX, modelId: 'provider/model', modelSource: 'provider_response',
    liveRunReceipt: { receiptId: 'run-1', completed: true, resultDigest: 'b'.repeat(64), modelId: 'provider/model', modelSource: 'provider_response' },
    result: { passed: true }, ...overrides,
  };
  receipt.digest = computeWorldBaselineDigest(receipt);
  return receipt;
}

test('resolves only safe identities beneath the one EAW baseline root', () => {
  const target = baselinePath(valid());
  assert.equal(path.dirname(target), WORLD_BASELINE_ROOT.replace(/\/$/, ''));
  for (const worldId of ['../escape', '..\\escape', '/absolute', 'x/y', 'x\\y', '..', 'x%2f..']) {
    assert.throws(() => baselinePath(valid({ worldId })), /safe baseline identity/);
  }
  assert.throws(() => baselinePath(valid(), { root: path.join(WORLD_BASELINE_ROOT, '..', '..', 'evals') }), /single EAW-owned/);
});

test('requires every assurance identity and complete live response provenance', () => {
  for (const field of ['suiteId', 'capabilityId', 'familyId', 'worldId']) {
    const receipt = valid(); delete receipt[field]; receipt.digest = computeWorldBaselineDigest(receipt);
    assert.match(validateWorldBaseline(receipt).errors.join(' '), new RegExp(field));
  }
  for (const key of ['worldSchema', 'renderer', 'policyPack', 'oracle', 'corpus']) {
    const receipt = valid(); delete receipt.lifecycle[key]; receipt.digest = computeWorldBaselineDigest(receipt);
    assert.match(validateWorldBaseline(receipt).errors.join(' '), new RegExp(key));
  }
  assert.match(validateWorldBaseline(valid({ solverDigest: 'not-a-digest' })).errors.join(' '), /solverDigest/);
  for (const field of ['receiptId', 'resultDigest']) {
    const receipt = valid(); delete receipt.liveRunReceipt[field]; receipt.digest = computeWorldBaselineDigest(receipt);
    assert.match(validateWorldBaseline(receipt).errors.join(' '), new RegExp(field));
  }
});

test('refuses model-source mismatch, fallback, and legacy-unproven assurance', () => {
  const mismatch = valid(); mismatch.liveRunReceipt.modelSource = 'configured_fallback'; mismatch.digest = computeWorldBaselineDigest(mismatch);
  assert.match(validateWorldBaseline(mismatch).errors.join(' '), /must equal modelSource/);
  for (const modelSource of ['configured_fallback', 'legacy_unproven']) {
    const receipt = valid({ modelSource }); receipt.liveRunReceipt.modelSource = modelSource; receipt.digest = computeWorldBaselineDigest(receipt);
    assert.match(validateWorldBaseline(receipt).errors.join(' '), /response-proven/);
  }
});

test('comparison refuses incompatible provenance instead of comparing results', () => {
  for (const candidate of [
    valid({ solverDigest: 'c'.repeat(64) }),
    valid({ familyId: 'other-family' }),
    valid({ lifecycle: { ...valid().lifecycle, oracle: 'v3' } }),
  ]) assert.equal(compareWorldBaseline(valid(), candidate).compatible, false);
  const fallback = valid({ modelSource: 'configured_fallback' }); fallback.liveRunReceipt.modelSource = 'configured_fallback'; fallback.digest = computeWorldBaselineDigest(fallback);
  assert.match(compareWorldBaseline(valid(), fallback).errors.join(' '), /response-proven/);
  assert.equal(compareWorldBaseline(valid(), valid()).compatible, true);
});

test('atomic save uses exclusive temporary creation, hard-link publication, and cleanup', async () => {
  const calls = [];
  const handle = { writeFile: async () => calls.push('write'), sync: async () => calls.push('sync'), close: async () => calls.push('close') };
  await saveWorldBaseline(valid(), { io: {
    open: async (_name, flags) => { calls.push(['open', flags]); return handle; },
    link: async () => calls.push('link'), unlink: async () => calls.push('unlink'),
  } });
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ['open', 'write', 'sync', 'close', 'link', 'unlink']);
});

test('save never clobbers and cleans a partial write', async () => {
  let cleaned = false;
  await assert.rejects(saveWorldBaseline(valid(), { io: {
    open: async () => ({ writeFile: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }, sync: async () => {}, close: async () => {} }),
    link: async () => assert.fail('must not publish'), unlink: async () => { cleaned = true; },
  } }), /disk full/);
  assert.equal(cleaned, true);
  await assert.rejects(saveWorldBaseline(valid(), { io: {
    open: async () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); }, unlink: async () => {},
  } }), /overwrite is forbidden/);
});

test('load refuses malformed existing JSON and never consults data/evals', async () => {
  const identity = valid({ worldId: 'malformed-test-only' });
  const target = baselinePath(identity);
  await writeFile(target, '{not json', 'utf8');
  try { await assert.rejects(loadWorldBaseline(identity), /malformed JSON/); }
  finally { await rm(target, { force: true }); }
  assert.doesNotMatch(target, /data[\\/]evals/);
});

test('canonical receipt digest detects mutation', () => {
  const receipt = valid();
  assert.equal(validateWorldBaseline(receipt).ok, true);
  receipt.result.passed = false;
  assert.match(validateWorldBaseline(receipt).errors.join(' '), /digest does not match/);
});

test('load refuses a baseline-file symlink escape', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eaw-baseline-'));
  const identity = valid({ worldId: 'symlink-test-only' });
  const target = baselinePath(identity);
  try {
    const outside = path.join(root, 'outside.json');
    await writeFile(outside, JSON.stringify(valid()), 'utf8');
    await symlink(outside, target);
    await assert.rejects(loadWorldBaseline(identity), /must not be a symlink/);
  } finally { await rm(target, { force: true }); await rm(root, { recursive: true, force: true }); }
});
