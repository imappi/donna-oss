// Unit tests for the pure helpers in scripts/backfill_services_engaged.js.
// The DB-touching path (runScript) is dry-run-by-default and exercised
// against the live DB before --apply; only the planning logic is unit-
// tested here.

import assert from 'node:assert/strict';
import test from 'node:test';

import { mapLegacyTilesToServices, planClientBackfill } from './backfill_services_engaged.js';

await test('mapLegacyTilesToServices: maps tile ids → service ids, deduped, junk dropped', () => {
  assert.deepEqual(mapLegacyTilesToServices(['bank', 'sales']), ['bank_reconciliation', 'sales_invoicing']);
  // Order preserved, dupes collapsed, unknown tiles dropped.
  assert.deepEqual(
    mapLegacyTilesToServices(['payroll', 'payroll', 'mystery', 'loans']),
    ['payroll', 'loan_tracking']
  );
  assert.deepEqual(mapLegacyTilesToServices([]), []);
  assert.deepEqual(mapLegacyTilesToServices('bank'), []); // non-array
});

await test('planClientBackfill: existing non-empty services_engaged → skip_already_scoped', () => {
  const plan = planClientBackfill({ services_engaged: ['payroll'] });
  assert.equal(plan.action, 'skip_already_scoped');
  assert.deepEqual(plan.services, ['payroll']);
});

await test('planClientBackfill: explicit empty services_engaged → skip_already_unscoped', () => {
  const plan = planClientBackfill({ services_engaged: [] });
  assert.equal(plan.action, 'skip_already_unscoped');
});

await test('planClientBackfill: legacy categories → write mapped services', () => {
  const plan = planClientBackfill({ applicable_intake_categories: ['bank', 'loans'] });
  assert.equal(plan.action, 'write');
  assert.deepEqual(plan.services, ['bank_reconciliation', 'loan_tracking']);
});

await test('planClientBackfill: neither field → skip_no_signal (never guesses [])', () => {
  const plan = planClientBackfill({});
  assert.equal(plan.action, 'skip_no_signal');
  assert.equal(plan.services, null);
});

await test('planClientBackfill: services_engaged takes priority over legacy', () => {
  const plan = planClientBackfill({
    services_engaged: ['bank_reconciliation'],
    applicable_intake_categories: ['payroll']
  });
  assert.equal(plan.action, 'skip_already_scoped');
  assert.deepEqual(plan.services, ['bank_reconciliation']);
});
