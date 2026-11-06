// Unit tests for the intent-compiler-shadow staging script — the PURE plan logic only
// (parseArgv + buildIntentCompilerShadowPlan), no live DB. Load-bearing properties:
//   - dry-run is the default (apply only when --apply present);
//   - default stage is SHADOW, default client is Honeybee (the canary discipline);
//   - the plan carries NO willAct: this flag never acts at any stage — live effect belongs
//     to a later, born-dark INTENT_OBJECT_ROUTING flag (the Kari flag-split decision);
//   - fail-closed: invalid stage or missing client is REFUSED;
//   - the flag key is pinned to INTENT_COMPILER_SHADOW, never taken from argv.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildIntentCompilerShadowPlan } from './enable_intent_compiler_shadow.js';

test('parseArgv: dry-run + Honeybee + shadow by default', () => {
  const o = parseArgv([]);
  assert.equal(o.apply, false);
  assert.equal(o.firmId, 'donna-production');
  assert.equal(o.clientId, 'honeybee-hills-apiary-llc');
  assert.equal(o.stage, 'shadow');
});

test('parseArgv: flags override the defaults (no --flag arg — the key is pinned)', () => {
  const o = parseArgv(['--apply', '--firm', 'f2', '--client', 'c2', '--stage', 'off', '--reason', 'rollback']);
  assert.deepEqual(o, { apply: true, firmId: 'f2', clientId: 'c2', stage: 'off', reason: 'rollback' });
});

test('the plan observes at shadow AND at canary/auto — but never exposes an act lever', () => {
  for (const stage of ['shadow', 'canary', 'auto']) {
    const p = buildIntentCompilerShadowPlan({ firmId: 'f', clientId: 'c', stage, currentStage: null });
    assert.equal(p.ok, true);
    assert.equal(p.flagKey, 'INTENT_COMPILER_SHADOW');
    assert.equal(p.willObserve, true, stage);
    assert.ok(!('willAct' in p), 'this flag must not model acting — INTENT_OBJECT_ROUTING is a different, later flag');
  }
  const off = buildIntentCompilerShadowPlan({ firmId: 'f', clientId: 'c', stage: 'off', currentStage: 'shadow' });
  assert.equal(off.willObserve, false);
  assert.equal(off.willChange, true);
});

test('fail-closed: invalid stage / missing client are refused', () => {
  assert.equal(buildIntentCompilerShadowPlan({ firmId: 'f', clientId: 'c', stage: 'on' }).ok, false);
  const noClient = buildIntentCompilerShadowPlan({ firmId: 'f', clientId: '', stage: 'shadow' });
  assert.equal(noClient.ok, false);
  assert.ok(noClient.errors[0].includes('clientId'));
});
