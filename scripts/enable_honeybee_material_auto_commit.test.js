// Unit tests for the material-auto-commit enablement script — the PURE plan logic only
// (parseArgv + buildEnablementPlan), no live DB. Load-bearing properties:
//   - dry-run is the default (apply only when --apply present);
//   - a stage that ACTS (canary/auto) is flagged as turning the seam ON;
//   - fail-closed: invalid stage, missing client, or a non-auto-commit flag is REFUSED so
//     the script can't silently flip the wrong thing live;
//   - the delegated-authority lever is marked grantRequired (scoped), material-auto-fyi is not.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildEnablementPlan } from './enable_honeybee_material_auto_commit.js';

test('parseArgv: dry-run + Honeybee + material-auto-fyi + canary by default', () => {
  const o = parseArgv([]);
  assert.equal(o.apply, false);
  assert.equal(o.firmId, 'donna-production');
  assert.equal(o.clientId, 'honeybee-hills-apiary-llc');
  assert.equal(o.flagKey, 'RECONCILIATION_MATERIAL_AUTO_FYI');
  assert.equal(o.stage, 'canary');
});

test('parseArgv: flags override the defaults', () => {
  const o = parseArgv(['--apply', '--firm', 'f2', '--client', 'c2', '--flag', 'RECONCILIATION_DELEGATED_AUTHORITY', '--stage', 'off', '--reason', 'rollback']);
  assert.deepEqual(o, {
    apply: true, firmId: 'f2', clientId: 'c2',
    flagKey: 'RECONCILIATION_DELEGATED_AUTHORITY', stage: 'off', reason: 'rollback'
  });
});

test('buildEnablementPlan: canary on material-auto-fyi ACTS, not grant-scoped', () => {
  const p = buildEnablementPlan({
    firmId: 'donna-production', clientId: 'honeybee-hills-apiary-llc',
    flagKey: 'RECONCILIATION_MATERIAL_AUTO_FYI', stage: 'canary', currentStage: 'off'
  });
  assert.equal(p.ok, true);
  assert.equal(p.willAct, true);
  assert.equal(p.willChange, true);
  assert.equal(p.grantRequired, false);
  assert.equal(p.from, 'off');
  assert.equal(p.to, 'canary');
});

test('buildEnablementPlan: delegated-authority is grant-scoped', () => {
  const p = buildEnablementPlan({
    firmId: 'f', clientId: 'c', flagKey: 'RECONCILIATION_DELEGATED_AUTHORITY', stage: 'auto'
  });
  assert.equal(p.grantRequired, true);
  assert.equal(p.willAct, true);
});

test('buildEnablementPlan: off / shadow do NOT act', () => {
  for (const stage of ['off', 'dry_run', 'shadow']) {
    const p = buildEnablementPlan({ firmId: 'f', clientId: 'c', flagKey: 'RECONCILIATION_MATERIAL_AUTO_FYI', stage });
    assert.equal(p.willAct, false, `${stage} must not act`);
    assert.equal(p.ok, true);
  }
});

test('buildEnablementPlan: refuses an invalid stage (fail-closed)', () => {
  const p = buildEnablementPlan({ firmId: 'f', clientId: 'c', flagKey: 'RECONCILIATION_MATERIAL_AUTO_FYI', stage: 'on' });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /invalid stage/);
  assert.equal(p.willAct, false);
});

test('buildEnablementPlan: refuses a missing client (no firm-wide default for auto-commit)', () => {
  const p = buildEnablementPlan({ firmId: 'f', clientId: null, flagKey: 'RECONCILIATION_MATERIAL_AUTO_FYI', stage: 'canary' });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /missing clientId/);
});

test('buildEnablementPlan: refuses a flag that is not a known auto-commit flag', () => {
  const p = buildEnablementPlan({ firmId: 'f', clientId: 'c', flagKey: 'SOME_OTHER_FLAG', stage: 'canary' });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /not a known auto-commit flag/);
});
