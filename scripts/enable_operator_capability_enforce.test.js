// Unit tests for the capability-enforce enablement script — the PURE plan logic only
// (parseArgv + buildEnforcementPlan), no live DB. Load-bearing properties:
//   - dry-run is the default (apply only when --apply present);
//   - a stage that ACTS (canary/auto) is flagged as turning enforcement ON;
//   - fail-closed: invalid stage or missing client is REFUSED (per-client canary
//     discipline — never a firm-wide default row);
//   - the flag key is pinned to operatorCapability.OPERATOR_CAPABILITY_FLAG_KEY,
//     never taken from argv (this script flips exactly one flag).

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildEnforcementPlan } from './enable_operator_capability_enforce.js';

test('parseArgv: dry-run + Honeybee + canary by default', () => {
  const o = parseArgv([]);
  assert.equal(o.apply, false);
  assert.equal(o.firmId, 'donna-production');
  assert.equal(o.clientId, 'honeybee-hills-apiary-llc');
  assert.equal(o.stage, 'canary');
});

test('parseArgv: flags override the defaults (no --flag arg — the key is pinned)', () => {
  const o = parseArgv(['--apply', '--firm', 'f2', '--client', 'c2', '--stage', 'off', '--reason', 'rollback']);
  assert.deepEqual(o, { apply: true, firmId: 'f2', clientId: 'c2', stage: 'off', reason: 'rollback' });
});

test('buildEnforcementPlan: canary ACTS and pins the flag key', () => {
  const p = buildEnforcementPlan({
    firmId: 'donna-production', clientId: 'honeybee-hills-apiary-llc',
    stage: 'canary', currentStage: null
  });
  assert.equal(p.ok, true);
  assert.equal(p.flagKey, 'OPERATOR_CAPABILITY_ENFORCE');
  assert.equal(p.willAct, true);
  assert.equal(p.willChange, true);
  assert.equal(p.from, null);
  assert.equal(p.to, 'canary');
});

test('buildEnforcementPlan: off / dry_run / shadow do NOT enforce', () => {
  for (const stage of ['off', 'dry_run', 'shadow']) {
    const p = buildEnforcementPlan({ firmId: 'f', clientId: 'c', stage });
    assert.equal(p.willAct, false, `${stage} must not enforce`);
    assert.equal(p.ok, true);
  }
});

test('buildEnforcementPlan: refuses an invalid stage (fail-closed)', () => {
  const p = buildEnforcementPlan({ firmId: 'f', clientId: 'c', stage: 'on' });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /invalid stage/);
  assert.equal(p.willAct, false);
});

test('buildEnforcementPlan: refuses a missing client (per-client canary discipline)', () => {
  const p = buildEnforcementPlan({ firmId: 'f', clientId: null, stage: 'canary' });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /missing clientId/);
});

test('buildEnforcementPlan: same-stage re-apply is allowed but flagged as no change', () => {
  const p = buildEnforcementPlan({ firmId: 'f', clientId: 'c', stage: 'canary', currentStage: 'canary' });
  assert.equal(p.ok, true);
  assert.equal(p.willChange, false);
});
