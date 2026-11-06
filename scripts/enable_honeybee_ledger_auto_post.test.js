import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildLedgerAutoPostEnablementPlan } from './enable_honeybee_ledger_auto_post.js';
import { LEDGER_AUTO_POST_FLAG_KEY } from '../server/donna/ledgerAutoPost.js';

await test('ledger auto-post enablement defaults to Honeybee canary dry-run', () => {
  const opts = parseArgv([]);
  assert.equal(opts.apply, false);
  assert.equal(opts.runSweep, false);
  assert.equal(opts.clientId, 'honeybee-hills-apiary-llc');
  assert.equal(opts.stage, 'canary');
});

await test('ledger auto-post plan is client-scoped and marks canary sweep as backlog-clearing', () => {
  const plan = buildLedgerAutoPostEnablementPlan({
    firmId: 'donna-production',
    clientId: 'honeybee-hills-apiary-llc',
    stage: 'canary',
    currentStage: null,
    runSweep: true
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.flagKey, LEDGER_AUTO_POST_FLAG_KEY);
  assert.equal(plan.willAct, true);
  assert.equal(plan.willClearBacklog, true);
});

await test('ledger auto-post plan refuses firm-wide or invalid-stage flips', () => {
  const plan = buildLedgerAutoPostEnablementPlan({ firmId: 'donna-production', stage: 'bogus' });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /missing clientId/);
  assert.match(plan.errors.join(' '), /invalid stage/);
});
