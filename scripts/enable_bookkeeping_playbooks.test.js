// Unit tests for the playbook-retrieval staging script — the PURE plan logic only
// (parseArgv + buildPlaybookStagePlan), no live DB. Load-bearing properties:
//   - dry-run is the default (apply only when --apply present);
//   - default stage is SHADOW (observe-first sizing), not canary — injection is the
//     deliberate second flip;
//   - a stage that ACTS (canary/auto) is flagged as turning prompt injection ON, and
//     shadow observes without acting;
//   - fail-closed: invalid stage or missing client is REFUSED (per-client canary
//     discipline — never a firm-wide default row);
//   - the flag key is pinned to bookkeepingPlaybooks.BOOKKEEPING_PLAYBOOK_FLAG_KEY,
//     never taken from argv (this script flips exactly one flag).

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildPlaybookStagePlan } from './enable_bookkeeping_playbooks.js';

test('parseArgv: dry-run + Honeybee + SHADOW by default (observe before inject)', () => {
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

test('buildPlaybookStagePlan: canary ACTS (injects) and pins the flag key', () => {
  const p = buildPlaybookStagePlan({
    firmId: 'donna-production', clientId: 'honeybee-hills-apiary-llc',
    stage: 'canary', currentStage: 'shadow'
  });
  assert.equal(p.ok, true);
  assert.equal(p.flagKey, 'BOOKKEEPING_PLAYBOOK_RETRIEVAL');
  assert.equal(p.willAct, true);
  assert.equal(p.willObserve, true);
  assert.equal(p.willChange, true);
  assert.equal(p.from, 'shadow');
  assert.equal(p.to, 'canary');
});

test('buildPlaybookStagePlan: shadow observes without acting; off/dry_run neither', () => {
  const shadow = buildPlaybookStagePlan({ firmId: 'f', clientId: 'c', stage: 'shadow' });
  assert.equal(shadow.willObserve, true);
  assert.equal(shadow.willAct, false);
  for (const stage of ['off', 'dry_run']) {
    const p = buildPlaybookStagePlan({ firmId: 'f', clientId: 'c', stage });
    assert.equal(p.ok, true);
    assert.equal(p.willObserve, false, `${stage} must not observe`);
    assert.equal(p.willAct, false, `${stage} must not act`);
  }
});

test('buildPlaybookStagePlan: refuses an invalid stage (fail-closed)', () => {
  const p = buildPlaybookStagePlan({ firmId: 'f', clientId: 'c', stage: 'on' });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /invalid stage/);
  assert.equal(p.willAct, false);
  assert.equal(p.willObserve, false);
});

test('buildPlaybookStagePlan: refuses a missing client (per-client canary discipline)', () => {
  const p = buildPlaybookStagePlan({ firmId: 'f', clientId: null, stage: 'shadow' });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /missing clientId/);
});

test('buildPlaybookStagePlan: same-stage re-apply is allowed but flagged as no-change', () => {
  const p = buildPlaybookStagePlan({ firmId: 'f', clientId: 'c', stage: 'shadow', currentStage: 'shadow' });
  assert.equal(p.ok, true);
  assert.equal(p.willChange, false);
});
