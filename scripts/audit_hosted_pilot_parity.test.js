import test from 'node:test';
import assert from 'node:assert/strict';
import { compareHostedPilotSchema, PILOT_REQUIRED_COLUMNS } from './audit_hosted_pilot_parity.js';
const columns = Object.entries(PILOT_REQUIRED_COLUMNS).flatMap(([table_name, names]) => names.map(column_name => ({ table_name, column_name })));
test('migration ledger alone cannot certify a missing runtime column', () => {
  const baseline = { expected: ['001', '151'], applied: ['001', '151'], columns };
  assert.equal(compareHostedPilotSchema(baseline).status, 'PASS');
  const missing = compareHostedPilotSchema({ ...baseline, columns: columns.filter(row => row.column_name !== 'coding_state') });
  assert.equal(missing.status, 'FAIL');
  assert.deepEqual(missing.missing_columns, ['transactions.coding_state']);
  assert.deepEqual(compareHostedPilotSchema({ ...baseline, applied: ['001'] }).missing_migrations, ['151']);
  assert.deepEqual(compareHostedPilotSchema({ ...baseline, applied: ['001', '151', '999'] }).unexpected_migrations, ['999']);
});
