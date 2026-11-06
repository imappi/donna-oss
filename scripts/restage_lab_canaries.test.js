// Unit tests for the lab canary re-stage script — PURE arg and plan logic,
// no live DB. Load-bearing properties:
//   - dry-run default (re-arming authority must never be accidental);
//   - the flag keys are PINNED, never taken from argv, and there are THREE
//     of them (the 2026-08-17 clean round stalled on a two-flag re-stage:
//     the disposition-driven ask gather stayed dark and the draft ignored
//     11 disposition verdicts);
//   - fail-closed on a bad stage or a missing client (no firm-wide flips);
//   - the plan carries each flag's current stage so the dry-run print is a
//     real receipt, not a guess.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildRestagePlan, LAB_CANARY_FLAG_KEYS } from './restage_lab_canaries.js';
import { DISPOSITION_DRIVEN_ASK_FLAG_KEY } from '../server/donna/firmDb.js';
import { MATERIAL_AUTO_FYI_FLAG_KEY } from '../server/donna/reconciliationLlmCore.js';
import { LEDGER_AUTO_POST_FLAG_KEY } from '../server/donna/ledgerAutoPost.js';

test('the pinned set is exactly the three authority canaries a reset kills', () => {
  assert.deepEqual(
    [...LAB_CANARY_FLAG_KEYS].sort(),
    [MATERIAL_AUTO_FYI_FLAG_KEY, LEDGER_AUTO_POST_FLAG_KEY, DISPOSITION_DRIVEN_ASK_FLAG_KEY].sort()
  );
  assert.equal(LAB_CANARY_FLAG_KEYS.length, 3, 'three canaries, not two — the §5.2 lesson');
});

test('parseArgv: dry-run + canary + lab defaults', () => {
  const o = parseArgv([]);
  assert.equal(o.apply, false);
  assert.equal(o.stage, 'canary');
  assert.equal(o.firmId, 'donna-demo-firm');
  assert.equal(o.clientId, 'honeybee-hills-apiary-llc');
});

test('parseArgv: overrides work; flag keys are never an arg', () => {
  const o = parseArgv(['--apply', '--firm', 'f2', '--client', 'c2', '--stage', 'off', '--reason', 'disarm']);
  assert.deepEqual(o, { apply: true, firmId: 'f2', clientId: 'c2', stage: 'off', reason: 'disarm' });
});

test('the plan lists all three flags with their current stages from the snapshot', () => {
  const plan = buildRestagePlan({
    firmId: 'f',
    clientId: 'c',
    stage: 'canary',
    snapshot: { [MATERIAL_AUTO_FYI_FLAG_KEY]: { stage: 'canary', source: 'manual' } }
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.flags.length, 3);
  const fyi = plan.flags.find((f) => f.flagKey === MATERIAL_AUTO_FYI_FLAG_KEY);
  assert.equal(fyi.currentStage, 'canary');
  const ask = plan.flags.find((f) => f.flagKey === DISPOSITION_DRIVEN_ASK_FLAG_KEY);
  assert.equal(ask.currentStage, null, 'an unstaged flag reads null (∅, fail-closed)');
});

test('fail-closed: invalid stage, missing client, missing firm are refused', () => {
  assert.equal(buildRestagePlan({ firmId: 'f', clientId: 'c', stage: 'nope' }).ok, false);
  assert.equal(buildRestagePlan({ firmId: 'f', clientId: '', stage: 'canary' }).ok, false);
  assert.equal(buildRestagePlan({ firmId: '', clientId: 'c', stage: 'canary' }).ok, false);
});
