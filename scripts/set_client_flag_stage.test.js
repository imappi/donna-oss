// Unit tests for the generic flag-stage lever — the PURE plan logic only
// (parseArgv + buildFlagStagePlan), no live DB. Load-bearing properties:
//   - dry-run is the default (apply only with --apply);
//   - scope is EXPLICIT: exactly one of --client / --firm-default — a firm-wide
//     "global on" row can never happen by omission, and never alongside a client;
//   - fail-closed: missing flag or invalid stage is REFUSED;
//   - willAct/willObserve mirror the CONFIG_STAGES vocabulary (canary/auto act,
//     shadow observes, off/dry_run dormant) so the operator sees the consequence
//     before --apply.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildFlagStagePlan } from './set_client_flag_stage.js';

test('parseArgv: dry-run by default, no implicit scope, donna firm default', () => {
  const o = parseArgv([]);
  assert.equal(o.apply, false);
  assert.equal(o.firmId, 'donna-production');
  assert.equal(o.clientId, null);
  assert.equal(o.firmDefault, false);
  assert.equal(o.flagKey, null);
  assert.equal(o.stage, null);
});

test('parseArgv: full client-canary invocation', () => {
  const o = parseArgv(['--flag', 'CODING_AUTO_POST', '--client', 'honeybee-hills-apiary-llc', '--stage', 'canary', '--reason', 'graduation act 1', '--apply']);
  assert.equal(o.apply, true);
  assert.equal(o.flagKey, 'CODING_AUTO_POST');
  assert.equal(o.clientId, 'honeybee-hills-apiary-llc');
  assert.equal(o.firmDefault, false);
  assert.equal(o.stage, 'canary');
  assert.equal(o.reason, 'graduation act 1');
});

test('plan: client canary row acts and reports the transition', () => {
  const p = buildFlagStagePlan({
    firmId: 'donna-production', clientId: 'honeybee-hills-apiary-llc',
    flagKey: 'CODING_AUTO_POST', stage: 'canary', currentStage: null
  });
  assert.equal(p.ok, true);
  assert.equal(p.firmDefault, false);
  assert.equal(p.willAct, true);
  assert.equal(p.willChange, true);
  assert.equal(p.from, null);
  assert.equal(p.to, 'canary');
});

test('plan: firm-default auto row (the "global on" rung) requires the explicit switch', () => {
  const explicit = buildFlagStagePlan({
    firmId: 'f', firmDefault: true, flagKey: 'CODING_AUTO_POST', stage: 'auto'
  });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.firmDefault, true);
  assert.equal(explicit.clientId, null);
  assert.equal(explicit.willAct, true);

  const implicit = buildFlagStagePlan({ firmId: 'f', flagKey: 'CODING_AUTO_POST', stage: 'auto' });
  assert.equal(implicit.ok, false, 'no scope given → refused, never an accidental global row');
});

test('plan: --client and --firm-default together are refused', () => {
  const p = buildFlagStagePlan({
    firmId: 'f', clientId: 'c', firmDefault: true, flagKey: 'X', stage: 'off'
  });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /mutually exclusive/);
});

test('plan: fail-closed on missing flag and on an invalid stage', () => {
  const noFlag = buildFlagStagePlan({ firmId: 'f', clientId: 'c', stage: 'canary' });
  assert.equal(noFlag.ok, false);
  const badStage = buildFlagStagePlan({ firmId: 'f', clientId: 'c', flagKey: 'X', stage: 'enabled' });
  assert.equal(badStage.ok, false);
  assert.equal(badStage.willAct, false);
  assert.equal(badStage.willObserve, false);
});

test('plan: stage vocabulary — shadow observes only, off/dry_run dormant, auto acts', () => {
  const shadow = buildFlagStagePlan({ firmId: 'f', clientId: 'c', flagKey: 'X', stage: 'shadow' });
  assert.equal(shadow.willObserve, true);
  assert.equal(shadow.willAct, false);
  for (const stage of ['off', 'dry_run']) {
    const p = buildFlagStagePlan({ firmId: 'f', clientId: 'c', flagKey: 'X', stage });
    assert.equal(p.willObserve, false, stage);
    assert.equal(p.willAct, false, stage);
  }
  const auto = buildFlagStagePlan({ firmId: 'f', clientId: 'c', flagKey: 'X', stage: 'auto' });
  assert.equal(auto.willAct, true);
});

test('plan: same-stage re-apply is allowed but flagged as no-change', () => {
  const p = buildFlagStagePlan({
    firmId: 'f', clientId: 'c', flagKey: 'X', stage: 'canary', currentStage: 'canary'
  });
  assert.equal(p.ok, true);
  assert.equal(p.willChange, false);
});
