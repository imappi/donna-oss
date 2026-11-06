import assert from 'node:assert/strict';

import { buildXeroCoaProvisionPlan, DONNA_COA_ACCOUNTS } from './xeroCoaProvisioning.js';

const existingDefaultAccounts = [
  { code: '200', name: 'Sales', type: 'REVENUE', status: 'ACTIVE', tax_type: 'OUTPUTY24' },
  { code: '401', name: 'Legacy software', type: 'EXPENSE', status: 'ACTIVE', tax_type: 'INPUTY24' },
  { code: '485', name: 'Subscriptions', type: 'EXPENSE', status: 'ACTIVE', tax_type: 'INPUTY24' },
  { code: '850', name: 'Suspense', type: 'CURRLIAB', status: 'ACTIVE', tax_type: 'NONE' }
];

const conflictPlan = buildXeroCoaProvisionPlan({ xeroAccounts: existingDefaultAccounts });
assert.equal(conflictPlan.counts.desired, DONNA_COA_ACCOUNTS.length);
assert.equal(conflictPlan.actions.find((item) => item.desired.code === '401')?.action, 'blocked');
assert.equal(conflictPlan.actions.find((item) => item.desired.code === '401')?.reason, 'code_conflict');
assert.equal(conflictPlan.actions.find((item) => item.desired.name === 'Sales income')?.action, 'create');

const withProvisionedAccounts = [
  ...existingDefaultAccounts,
  { code: '201', name: 'Sales income', type: 'REVENUE', status: 'ACTIVE', tax_type: 'OUTPUTY24' },
  { code: '402', name: 'Professional fees', type: 'EXPENSE', status: 'ACTIVE', tax_type: 'INPUTY24' }
];
const provisionedPlan = buildXeroCoaProvisionPlan({ xeroAccounts: withProvisionedAccounts });
assert.equal(provisionedPlan.actions.find((item) => item.desired.name === 'Sales income')?.action, 'already_exists');
assert.equal(provisionedPlan.actions.find((item) => item.desired.name === 'Professional fees')?.action, 'already_exists');

const emptyPlan = buildXeroCoaProvisionPlan({ xeroAccounts: [] });
assert.equal(emptyPlan.counts.create, DONNA_COA_ACCOUNTS.length);
assert.deepEqual(emptyPlan.actions[0].payload, {
  Code: '201',
  Name: 'Sales income',
  Type: 'REVENUE',
  TaxType: 'OUTPUTY24',
  Description: 'Revenue from normal business activity, provisioned by Donna.'
});

console.log('Xero CoA provisioning tests passed');
