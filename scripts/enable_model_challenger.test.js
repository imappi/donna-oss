// Unit tests for the challenger staging script — the PURE plan logic only
// (parseArgv + buildChallengerStagePlan), no live DB. Load-bearing properties:
//   - dry-run is the default (apply only when --apply present);
//   - default stage is SHADOW for the default Donna-operated pilot pair;
//   - the exactly-one-pilot guard REFUSES a second concurrent observing
//     (firm, client) unless --allow-additional (a new dated decision);
//   - fail-closed: invalid stage or missing client is REFUSED;
//   - the flag key is pinned to modelChallenger.MODEL_CHALLENGER_FLAG_KEY,
//     never taken from argv (this script flips exactly one flag);
//   - off/dry_run neither observes nor guards — rollback is always allowed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildChallengerStagePlan } from './enable_model_challenger.js';

test('parseArgv: dry-run + the default pilot pair + SHADOW by default', () => {
  const o = parseArgv([]);
  assert.equal(o.apply, false);
  assert.equal(o.allowAdditional, false);
  assert.equal(o.firmId, 'donna-production');
  assert.equal(o.clientId, 'honeybee-hills-apiary-llc');
  assert.equal(o.stage, 'shadow');
});

test('parseArgv: flags override the defaults (no --flag arg — the key is pinned)', () => {
  const o = parseArgv(['--apply', '--allow-additional', '--firm', 'f2', '--client', 'c2', '--stage', 'off', '--reason', 'rollback']);
  assert.deepEqual(o, { apply: true, allowAdditional: true, firmId: 'f2', clientId: 'c2', stage: 'off', reason: 'rollback' });
});

test('buildChallengerStagePlan: shadow observes and pins the flag key', () => {
  const p = buildChallengerStagePlan({
    firmId: 'donna-production', clientId: 'honeybee-hills-apiary-llc',
    stage: 'shadow', currentStage: null
  });
  assert.equal(p.ok, true);
  assert.equal(p.flagKey, 'MODEL_CHALLENGER');
  assert.equal(p.willObserve, true);
  assert.equal(p.willChange, true);
  assert.equal(p.from, null);
  assert.equal(p.to, 'shadow');
});

test('the exactly-one-pilot guard: a second concurrent observing pilot is REFUSED without --allow-additional', () => {
  const others = [{ firm_id: 'donna-production', client_id: 'other-client', stage: 'shadow' }];
  const refused = buildChallengerStagePlan({
    firmId: 'donna-production', clientId: 'honeybee-hills-apiary-llc',
    stage: 'shadow', otherObservingPilots: others
  });
  assert.equal(refused.ok, false);
  assert.match(refused.errors.join(' '), /exactly ONE pilot/);

  const allowed = buildChallengerStagePlan({
    firmId: 'donna-production', clientId: 'honeybee-hills-apiary-llc',
    stage: 'shadow', otherObservingPilots: others, allowAdditional: true
  });
  assert.equal(allowed.ok, true);
});

test('the guard never blocks rollback: off/dry_run apply even with another observing pilot', () => {
  const others = [{ firm_id: 'f', client_id: 'c2', stage: 'shadow' }];
  for (const stage of ['off', 'dry_run']) {
    const p = buildChallengerStagePlan({ firmId: 'f', clientId: 'c1', stage, otherObservingPilots: others });
    assert.equal(p.ok, true, `${stage} must not be blocked by the guard`);
    assert.equal(p.willObserve, false, `${stage} must not observe`);
  }
});

test('buildChallengerStagePlan: refuses an invalid stage and a missing client (fail-closed)', () => {
  const badStage = buildChallengerStagePlan({ firmId: 'f', clientId: 'c', stage: 'on' });
  assert.equal(badStage.ok, false);
  assert.match(badStage.errors.join(' '), /invalid stage/);

  const noClient = buildChallengerStagePlan({ firmId: 'f', clientId: null, stage: 'shadow' });
  assert.equal(noClient.ok, false);
  assert.match(noClient.errors.join(' '), /missing clientId/);
});

test('buildChallengerStagePlan: same-stage re-apply is allowed but flagged as no-change', () => {
  const p = buildChallengerStagePlan({ firmId: 'f', clientId: 'c', stage: 'shadow', currentStage: 'shadow' });
  assert.equal(p.ok, true);
  assert.equal(p.willChange, false);
});
