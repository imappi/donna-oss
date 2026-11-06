// Unit tests for the evidence-topic reminder staging + trigger scripts — PURE arg
// and plan logic only, no live DB. Load-bearing properties:
//   - enable: dry-run default, flag key PINNED, fail-closed on bad stage/missing client;
//   - canary/auto ACT, off/shadow/dry_run do not;
//   - trigger: refuses a sweep with no --client (never fans out across the firm).
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv as parseEnableArgv, buildReminderFlagPlan } from './enable_evidence_topic_reminders.js';
import { parseArgv as parseSweepArgv } from './run_evidence_topic_reminder_sweep.js';
import { EVIDENCE_TOPIC_REMINDERS_FLAG_KEY } from '../server/donna/channels/evidenceTopicReminders.js';

test('enable parseArgv: dry-run + canary by default', () => {
  const o = parseEnableArgv([]);
  assert.equal(o.apply, false);
  assert.equal(o.stage, 'canary');
});

test('enable parseArgv: flags override defaults (key is pinned, not an arg)', () => {
  const o = parseEnableArgv(['--apply', '--firm', 'f2', '--client', 'c2', '--stage', 'off', '--reason', 'rollback']);
  assert.deepEqual(o, { apply: true, firmId: 'f2', clientId: 'c2', stage: 'off', reason: 'rollback' });
});

test('enable plan pins the flag key; canary/auto act, others do not', () => {
  const canary = buildReminderFlagPlan({ firmId: 'f', clientId: 'c', stage: 'canary' });
  assert.equal(canary.ok, true);
  assert.equal(canary.flagKey, EVIDENCE_TOPIC_REMINDERS_FLAG_KEY);
  assert.equal(canary.willAct, true);
  assert.equal(buildReminderFlagPlan({ firmId: 'f', clientId: 'c', stage: 'auto' }).willAct, true);
  for (const stage of ['off', 'shadow', 'dry_run']) {
    assert.equal(buildReminderFlagPlan({ firmId: 'f', clientId: 'c', stage }).willAct, false);
  }
});

test('enable plan fail-closed: invalid stage and missing client refused', () => {
  assert.equal(buildReminderFlagPlan({ firmId: 'f', clientId: 'c', stage: 'nope' }).ok, false);
  assert.equal(buildReminderFlagPlan({ firmId: 'f', clientId: '', stage: 'canary' }).ok, false);
});

test('sweep parseArgv: client is null unless given (main refuses a firm-wide sweep)', () => {
  assert.equal(parseSweepArgv([]).clientId, null);
  assert.equal(parseSweepArgv(['--client', 'demo-co']).clientId, 'demo-co');
  assert.equal(parseSweepArgv(['--client', 'demo-co', '--limit', '5']).limit, 5);
});
