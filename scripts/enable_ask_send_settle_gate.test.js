// Unit tests for the ask-send settle-gate staging script — PURE arg and plan
// logic only, no live DB. Load-bearing properties:
//   - dry-run default (staging a send-behaviour change must never be accidental);
//   - the flag key is PINNED, never taken from argv;
//   - canary/auto ACT, off/shadow/dry_run do not;
//   - fail-closed on a bad stage or a missing client.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildSettleGatePlan } from './enable_ask_send_settle_gate.js';
import { ASK_SEND_SETTLE_FLAG_KEY } from '../server/donna/askAutoSendProducer.js';

test('parseArgv: dry-run + canary by default', () => {
  const o = parseArgv([]);
  assert.equal(o.apply, false);
  assert.equal(o.stage, 'canary');
  assert.equal(o.clientId, 'honeybee-hills-apiary-llc');
});

test('parseArgv: flags override defaults (the key is pinned, not an arg)', () => {
  const o = parseArgv(['--apply', '--firm', 'f2', '--client', 'c2', '--stage', 'off', '--reason', 'rollback']);
  assert.deepEqual(o, { apply: true, firmId: 'f2', clientId: 'c2', stage: 'off', reason: 'rollback' });
});

test('the plan pins the flag key; canary/auto act, others do not', () => {
  const canary = buildSettleGatePlan({ firmId: 'f', clientId: 'c', stage: 'canary' });
  assert.equal(canary.ok, true);
  assert.equal(canary.flagKey, ASK_SEND_SETTLE_FLAG_KEY);
  assert.equal(canary.willAct, true);
  assert.equal(buildSettleGatePlan({ firmId: 'f', clientId: 'c', stage: 'auto' }).willAct, true);
  for (const stage of ['off', 'shadow', 'dry_run']) {
    assert.equal(buildSettleGatePlan({ firmId: 'f', clientId: 'c', stage }).willAct, false, `${stage} must stay dormant`);
  }
});

test('fail-closed: an invalid stage or a missing client is refused', () => {
  assert.equal(buildSettleGatePlan({ firmId: 'f', clientId: 'c', stage: 'nope' }).ok, false);
  assert.equal(buildSettleGatePlan({ firmId: 'f', clientId: '', stage: 'canary' }).ok, false);
  assert.equal(buildSettleGatePlan({ firmId: '', clientId: 'c', stage: 'canary' }).ok, false);
});

test('the rollback path is a first-class plan, not a special case', () => {
  const off = buildSettleGatePlan({ firmId: 'f', clientId: 'c', stage: 'off', currentStage: 'canary' });
  assert.equal(off.ok, true);
  assert.equal(off.willAct, false);
  assert.equal(off.currentStage, 'canary');
});
