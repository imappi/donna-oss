// buildRestagePlan — pure plan tests for the re-stage-from-purge-receipt
// affordance (CLAUDE.md #12, fourth sighting 2026-08-25). The rail under
// test: flags re-stage explicitly (operator-staged rows only — seeds
// re-appear on their own), grants and bench assignments are CHECKLIST ONLY
// (never auto-recreated — reviving authority mechanically is the silent
// re-arm the authority-plane rail forbids).

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRestagePlan, parseArgv } from './restage_authority_from_purge_receipt.js';

const receipt = {
  id: '9001',
  metadata: {
    flags: [
      { flag_key: 'RECONCILIATION_MATERIAL_AUTO_FYI', stage: 'canary', source: 'manual', reason: 'honeybee canary' },
      { flag_key: 'BANK_STATEMENT_LLM_EXTRACTION', stage: 'canary', source: 'manual', reason: null },
      { flag_key: 'SOME_BASELINE', stage: 'auto', source: 'default', reason: 'seed' }
    ],
    grants: [{ id: 'g-1', scope_kind: 'merchant', scope_key: 'sw gas', archetype: 'material_match', amount_ceiling: 500, status: 'active' }],
    action_grants: [],
    role_assignments: [{ id: 'ra-1', role: 'maya', principal_type: 'ai', status: 'active' }]
  }
};

test('operator-staged flags restage; seeds and grants do not', () => {
  const plan = buildRestagePlan({ receipt, clientExists: true, currentStages: {} });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.restage.map((r) => r.flagKey), [
    'RECONCILIATION_MATERIAL_AUTO_FYI', 'BANK_STATEMENT_LLM_EXTRACTION'
  ], 'source=default seed rows are not restaged');
  assert.deepEqual(plan.seedsInReceipt, ['SOME_BASELINE']);
  assert.equal(plan.grants.length, 1, 'grants ride the plan as checklist data only');
  assert.equal(plan.roleAssignments.length, 1);
});

test('a flag already at its receipt stage is marked skip (idempotent re-run)', () => {
  const plan = buildRestagePlan({
    receipt, clientExists: true,
    currentStages: { RECONCILIATION_MATERIAL_AUTO_FYI: 'canary' }
  });
  const fyi = plan.restage.find((r) => r.flagKey === 'RECONCILIATION_MATERIAL_AUTO_FYI');
  assert.equal(fyi.alreadyStaged, true);
  const ext = plan.restage.find((r) => r.flagKey === 'BANK_STATEMENT_LLM_EXTRACTION');
  assert.equal(ext.alreadyStaged, false);
});

test('refuses without a receipt or without the target client', () => {
  assert.equal(buildRestagePlan({ receipt: null, clientExists: true }).ok, false);
  const noClient = buildRestagePlan({ receipt, clientExists: false });
  assert.equal(noClient.ok, false);
  assert.match(noClient.errors.join(' '), /this script stages, it never creates/);
});

test('parseArgv defaults from-client to client and stays dry-run by default', () => {
  const opts = parseArgv(['--firm', 'donna-demo-firm', '--client', 'honeybee-hills-apiary-llc']);
  assert.equal(opts.firmId, 'donna-demo-firm');
  assert.equal(opts.fromClientId, 'honeybee-hills-apiary-llc');
  assert.equal(opts.apply, false);
  const explicit = parseArgv(['--client', 'new-id', '--from-client', 'old-id', '--apply']);
  assert.equal(explicit.fromClientId, 'old-id');
  assert.equal(explicit.apply, true);
});
