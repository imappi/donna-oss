// Unit tests for the self-knowledge staging lever — the PURE plan logic only
// (parseArgv + buildSelfKnowledgePlan), no live DB. Load-bearing properties:
//   - dry-run is the default (apply only when --apply present);
//   - default stage is CANARY (these flags ACT at canary), default client is
//     Honeybee (the canary discipline), both flags staged together by default;
//   - fail-closed: invalid stage or missing client is REFUSED;
//   - the flag keys are pinned to SELF_KNOWLEDGE_CONTEXT / OWNER_PORTAL_LINK,
//     never taken from argv.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildSelfKnowledgePlan } from './enable_self_knowledge_context.js';

test('parseArgv: dry-run + Honeybee + canary + both flags by default', () => {
  const o = parseArgv([]);
  assert.equal(o.apply, false);
  assert.equal(o.firmId, 'donna-production');
  assert.equal(o.clientId, 'honeybee-hills-apiary-llc');
  assert.equal(o.stage, 'canary');
  assert.equal(o.portalLink, true);
});

test('parseArgv: flags override the defaults (no --flag arg — the keys are pinned)', () => {
  const o = parseArgv(['--apply', '--firm', 'f2', '--client', 'c2', '--stage', 'off', '--no-portal-link', '--reason', 'rollback']);
  assert.deepEqual(o, { apply: true, firmId: 'f2', clientId: 'c2', stage: 'off', portalLink: false, reason: 'rollback' });
});

test('the plan acts at canary/auto and stays dark at off/dry_run/shadow', () => {
  for (const [stage, acts] of [['off', false], ['dry_run', false], ['shadow', false], ['canary', true], ['auto', true]]) {
    const p = buildSelfKnowledgePlan({ firmId: 'f', clientId: 'c', stage });
    assert.equal(p.ok, true, stage);
    assert.equal(p.willAct, acts, stage);
  }
});

test('both flags by default; --no-portal-link stages the context pack alone', () => {
  const both = buildSelfKnowledgePlan({ firmId: 'f', clientId: 'c', stage: 'canary', portalLink: true });
  assert.deepEqual(both.flagKeys, ['SELF_KNOWLEDGE_CONTEXT', 'OWNER_PORTAL_LINK']);
  const one = buildSelfKnowledgePlan({ firmId: 'f', clientId: 'c', stage: 'canary', portalLink: false });
  assert.deepEqual(one.flagKeys, ['SELF_KNOWLEDGE_CONTEXT']);
});

test('fail-closed: invalid stage / missing client are refused', () => {
  assert.equal(buildSelfKnowledgePlan({ firmId: 'f', clientId: 'c', stage: 'on' }).ok, false);
  const noClient = buildSelfKnowledgePlan({ firmId: 'f', clientId: '', stage: 'canary' });
  assert.equal(noClient.ok, false);
  assert.ok(noClient.errors[0].includes('clientId'));
});

test('current stages ride the plan for the dry-run rendering', () => {
  const p = buildSelfKnowledgePlan({
    firmId: 'f', clientId: 'c', stage: 'canary',
    currentStages: { SELF_KNOWLEDGE_CONTEXT: 'off' }
  });
  assert.deepEqual(p.from, ['off', null]);
  assert.equal(p.to, 'canary');
});
