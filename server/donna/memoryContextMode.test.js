// Donna — BizOS Slice 2c-iii (sub-PR 4): security-suspension + mode precedence.
// Proves invariant test 16: suspension withholds BOTH v2 and legacy, and wins over
// force-disable and any per-client stage; force-disable (without suspension)
// restores legacy.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MEMORY_RETRIEVAL_V2_FLAG_KEY } from './memoryRetrieval.js';
import {
  MEMORY_CONTEXT_SECURITY_SUSPEND_KEY,
  MEMORY_MODES,
  securitySuspendedByEnv,
  securitySuspended,
  resolveMemoryMode,
  buildSecuritySuspensionAuditEvent
} from './memoryContextMode.js';

const stageRow = (stage) => ({ [MEMORY_RETRIEVAL_V2_FLAG_KEY]: { stage, source: 'manual' } });
const suspendRow = (stage = 'canary') => ({ [MEMORY_CONTEXT_SECURITY_SUSPEND_KEY]: { stage, source: 'manual' } });
const clean = {};

// ── env kill ──────────────────────────────────────────────────────────────────

test('securitySuspendedByEnv: born false; truthy values suspend', () => {
  assert.equal(securitySuspendedByEnv(clean), false);
  assert.equal(securitySuspendedByEnv({ [MEMORY_CONTEXT_SECURITY_SUSPEND_KEY]: '' }), false);
  for (const v of ['1', 'true', 'on', 'yes', 'all', 'ALL', 'True']) {
    assert.equal(securitySuspendedByEnv({ [MEMORY_CONTEXT_SECURITY_SUSPEND_KEY]: v }), true, v);
  }
  assert.equal(securitySuspendedByEnv({ [MEMORY_CONTEXT_SECURITY_SUSPEND_KEY]: 'off' }), false);
});

test('securitySuspended: config-plane row at non-off stage suspends (per-firm)', () => {
  assert.equal(securitySuspended({ configSnapshot: suspendRow('canary'), env: clean }), true);
  assert.equal(securitySuspended({ configSnapshot: suspendRow('shadow'), env: clean }), true);
  assert.equal(securitySuspended({ configSnapshot: suspendRow('off'), env: clean }), false);
  assert.equal(securitySuspended({ configSnapshot: {}, env: clean }), false);
});

// ── resolveMemoryMode precedence (test 16) ────────────────────────────────────

test('resolveMemoryMode: canary stage → v2', () => {
  assert.equal(resolveMemoryMode({ configSnapshot: stageRow('canary'), env: clean }), 'v2');
});

test('resolveMemoryMode: off/shadow → legacy', () => {
  assert.equal(resolveMemoryMode({ configSnapshot: stageRow('shadow'), env: clean }), 'legacy');
  assert.equal(resolveMemoryMode({ configSnapshot: {}, env: clean }), 'legacy');
});

test('resolveMemoryMode: force-disable (no suspension) → legacy (operational rollback)', () => {
  const mode = resolveMemoryMode({
    configSnapshot: stageRow('canary'),
    env: { CLIENT_CONFIG_FORCE_DISABLE: 'MEMORY_RETRIEVAL_V2' }
  });
  assert.equal(mode, 'legacy');
});

test('resolveMemoryMode: suspension WINS over a canary stage → suspended (neither v2 nor legacy)', () => {
  const mode = resolveMemoryMode({ configSnapshot: { ...stageRow('canary'), ...suspendRow('canary') }, env: clean });
  assert.equal(mode, 'suspended');
});

test('resolveMemoryMode: env suspension WINS over force-disable AND stage (test 16 precedence)', () => {
  const mode = resolveMemoryMode({
    configSnapshot: stageRow('canary'),
    env: { [MEMORY_CONTEXT_SECURITY_SUSPEND_KEY]: 'all', CLIENT_CONFIG_FORCE_DISABLE: 'MEMORY_RETRIEVAL_V2' }
  });
  assert.equal(mode, 'suspended');
});

test('resolveMemoryMode: always returns a known mode', () => {
  for (const snap of [{}, stageRow('canary'), suspendRow(), stageRow('off')]) {
    assert.ok(MEMORY_MODES.includes(resolveMemoryMode({ configSnapshot: snap, env: clean })));
  }
});

// ── audit ─────────────────────────────────────────────────────────────────────

test('buildSecuritySuspensionAuditEvent: records withheld=[v2,legacy] + provenance', () => {
  const ev = buildSecuritySuspensionAuditEvent({ firmId: 'f1', clientId: 'c1', source: 'env', retrievalId: 'retr-x', purposeId: 'portal_owner_context' });
  assert.equal(ev.action, 'memory_context.security_suspended');
  assert.equal(ev.resource_id, MEMORY_CONTEXT_SECURITY_SUSPEND_KEY);
  assert.deepEqual(ev.metadata.withheld, ['v2', 'legacy']);
  assert.equal(ev.metadata.retrieval_id, 'retr-x');
  assert.equal(ev.firm_id, 'f1');
});
