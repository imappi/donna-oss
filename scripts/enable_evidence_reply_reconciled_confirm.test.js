// Unit tests for the reply-confirmation staging script — PURE plan logic only
// (parseArgv + buildConfirmFlagPlan), no live DB. Load-bearing properties:
//   - dry-run is the default (apply only when --apply present);
//   - the flag key is PINNED (never taken from argv);
//   - fail-closed: an invalid stage or a missing client is REFUSED;
//   - canary/auto ACT; off/shadow/dry_run do not.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildConfirmFlagPlan } from './enable_evidence_reply_reconciled_confirm.js';
import { EVIDENCE_REPLY_RECONCILED_CONFIRM_FLAG_KEY } from '../server/donna/channels/evidenceReplyConfirm.js';

test('parseArgv: dry-run + canary by default', () => {
  const o = parseArgv([]);
  assert.equal(o.apply, false);
  assert.equal(o.firmId, 'donna-production');
  assert.equal(o.stage, 'canary');
});

test('parseArgv: flags override defaults (no --flag arg — the key is pinned)', () => {
  const o = parseArgv(['--apply', '--firm', 'f2', '--client', 'c2', '--stage', 'off', '--reason', 'rollback']);
  assert.deepEqual(o, { apply: true, firmId: 'f2', clientId: 'c2', stage: 'off', reason: 'rollback' });
});

test('plan pins the flag key and marks canary/auto as acting', () => {
  const canary = buildConfirmFlagPlan({ firmId: 'f', clientId: 'c', stage: 'canary' });
  assert.equal(canary.ok, true);
  assert.equal(canary.flagKey, EVIDENCE_REPLY_RECONCILED_CONFIRM_FLAG_KEY);
  assert.equal(canary.willAct, true);
  assert.equal(buildConfirmFlagPlan({ firmId: 'f', clientId: 'c', stage: 'auto' }).willAct, true);
});

test('off/shadow/dry_run do not act', () => {
  for (const stage of ['off', 'shadow', 'dry_run']) {
    const plan = buildConfirmFlagPlan({ firmId: 'f', clientId: 'c', stage });
    assert.equal(plan.ok, true);
    assert.equal(plan.willAct, false);
  }
});

test('fail-closed: invalid stage and missing client are refused', () => {
  assert.equal(buildConfirmFlagPlan({ firmId: 'f', clientId: 'c', stage: 'sometimes' }).ok, false);
  assert.equal(buildConfirmFlagPlan({ firmId: 'f', clientId: '', stage: 'canary' }).ok, false);
  assert.equal(buildConfirmFlagPlan({ firmId: '', clientId: 'c', stage: 'canary' }).ok, false);
});
