import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildCodingAutoPostEnablementPlan } from './enable_honeybee_coding_auto_post.js';
import { CODING_AUTO_POST_FLAG_KEY } from '../server/donna/codingAutoPost.js';

await test('coding auto-post enablement defaults to Honeybee canary dry-run', () => {
  const opts = parseArgv([]);
  assert.equal(opts.apply, false);
  assert.equal(opts.runSweep, false);
  assert.equal(opts.clientId, 'honeybee-hills-apiary-llc');
  assert.equal(opts.stage, 'canary');
});

await test('coding auto-post plan is client-scoped and marks canary sweep as backlog-clearing', () => {
  const plan = buildCodingAutoPostEnablementPlan({
    firmId: 'donna-production',
    clientId: 'honeybee-hills-apiary-llc',
    stage: 'canary',
    currentStage: null,
    runSweep: true
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.flagKey, CODING_AUTO_POST_FLAG_KEY);
  assert.equal(plan.willAct, true);
  assert.equal(plan.willClearBacklog, true);
});

await test('coding auto-post plan refuses firm-wide or invalid-stage flips', () => {
  const plan = buildCodingAutoPostEnablementPlan({ firmId: 'donna-production', stage: 'bogus' });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /missing clientId/);
  assert.match(plan.errors.join(' '), /invalid stage/);
});
