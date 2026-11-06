import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GB_SALES_TAX_REPAIR_REFUSALS,
  parseArgv,
  planConfirmedGbSalesTaxRepair,
  planGbSalesTaxRoleReport
} from './backfill_gb_sales_tax_roles.js';

const gbAccount = (id, clientId, name) => ({
  id,
  client_id: clientId,
  jurisdiction: 'GB',
  canonical_role: 'liability.tax_payable',
  name
});

test('argv defaults to report-only and parses the operator scope', () => {
  assert.deepEqual(parseArgv([]), {
    apply: false, firmId: 'donna-demo-firm', clientId: null, accountId: null
  });
  assert.deepEqual(parseArgv(['--apply', '--firm', 'f', '--client', 'c', '--account', 'a1']), {
    apply: true, firmId: 'f', clientId: 'c', accountId: 'a1'
  });
});

// The defect this script shipped with: it treated a single legacy account as
// unambiguous and rewrote it. On a GB book that row is as likely to be
// Corporation tax payable (gb/defaultChart.js assigns liability.tax_payable at
// code 2230), so arity is not evidence. The report must never yield an update.
test('a single legacy account is REPORTED, never rewritten', () => {
  const report = planGbSalesTaxRoleReport([gbAccount('a1', 'c1', 'Corporation tax payable')]);
  assert.equal(report.length, 1);
  assert.equal(report[0].action, 'report');
  assert.deepEqual(report[0].candidates, [{ id: 'a1', name: 'Corporation tax payable' }]);
  assert.ok(!report.some((entry) => entry.action === 'update'));
});

// Two accounts on the shared role is the EXPECTED GB legacy shape
// (accountRoles.js:57-64), not an anomaly to skip past.
test('the expected two-account GB shape is reported with both candidates', () => {
  const report = planGbSalesTaxRoleReport([
    gbAccount('a1', 'c1', 'VAT payable'),
    { ...gbAccount('a2', 'c1', 'Corporation tax payable'), jurisdiction: 'gb' }
  ]);
  assert.equal(report.length, 1);
  assert.equal(report[0].action, 'report');
  assert.deepEqual(report[0].candidates, [
    { id: 'a1', name: 'VAT payable' },
    { id: 'a2', name: 'Corporation tax payable' }
  ]);
});

test('report ignores foreign books, other roles, and unroled accounts', () => {
  assert.deepEqual(planGbSalesTaxRoleReport([
    { id: 'a1', client_id: 'c1', jurisdiction: 'FI', canonical_role: 'liability.tax_payable' },
    { id: 'a2', client_id: 'c2', jurisdiction: 'GB', canonical_role: null, name: 'VAT control' },
    { id: 'a3', client_id: 'c3', jurisdiction: 'GB', canonical_role: 'liability.accounts_payable' }
  ]), []);
});

// A name that looks decisive must still not decide: role inference from a name
// is Keep-layer scaffolding the sibling backfill_canonical_roles.js also refuses.
test('an account named "VAT control" is still only a candidate', () => {
  const report = planGbSalesTaxRoleReport([gbAccount('a1', 'c1', 'VAT control')]);
  assert.equal(report[0].action, 'report');
  assert.deepEqual(report[0].candidates, [{ id: 'a1', name: 'VAT control' }]);
});

test('an operator choice repairs exactly the named account', () => {
  const accounts = [gbAccount('a1', 'c1', 'VAT payable'), gbAccount('a2', 'c1', 'Corporation tax payable')];
  assert.deepEqual(planConfirmedGbSalesTaxRepair(accounts, { clientId: 'c1', accountId: 'a1' }), {
    action: 'update',
    client_id: 'c1',
    id: 'a1',
    from: 'liability.tax_payable',
    to: 'liability.sales_tax_payable'
  });
});

test('no named account refuses even when only one candidate exists', () => {
  const plan = planConfirmedGbSalesTaxRepair([gbAccount('a1', 'c1', 'VAT payable')], { clientId: 'c1' });
  assert.equal(plan.action, 'refuse');
  assert.equal(plan.reason, 'account_not_specified');
  assert.deepEqual(plan.candidates, [{ id: 'a1', name: 'VAT payable' }]);
});

test('an operator cannot re-role an account the report never surfaced', () => {
  const accounts = [
    gbAccount('a1', 'c1', 'VAT payable'),
    { id: 'a9', client_id: 'c1', jurisdiction: 'GB', canonical_role: 'liability.accounts_payable', name: 'Trade creditors' },
    gbAccount('b1', 'c2', 'VAT payable')
  ];
  // Wrong role on the same client.
  assert.deepEqual(planConfirmedGbSalesTaxRepair(accounts, { clientId: 'c1', accountId: 'a9' }), {
    action: 'refuse',
    reason: 'account_not_a_candidate',
    client_id: 'c1',
    account_id: 'a9',
    candidates: [{ id: 'a1', name: 'VAT payable' }]
  });
  // Right role, but another client's account.
  assert.equal(
    planConfirmedGbSalesTaxRepair(accounts, { clientId: 'c1', accountId: 'b1' }).reason,
    'account_not_a_candidate'
  );
});

test('a client with no candidates refuses rather than reporting a repair', () => {
  assert.deepEqual(planConfirmedGbSalesTaxRepair([], { clientId: 'c1', accountId: 'a1' }), {
    action: 'refuse', reason: 'no_candidates', client_id: 'c1'
  });
});

test('every refusal reason emitted is in the closed vocabulary', () => {
  const accounts = [gbAccount('a1', 'c1', 'VAT payable')];
  const reasons = [
    planConfirmedGbSalesTaxRepair([], { clientId: 'c1', accountId: 'a1' }).reason,
    planConfirmedGbSalesTaxRepair(accounts, { clientId: 'c1' }).reason,
    planConfirmedGbSalesTaxRepair(accounts, { clientId: 'c1', accountId: 'nope' }).reason
  ];
  assert.deepEqual([...new Set(reasons)].sort(), [...GB_SALES_TAX_REPAIR_REFUSALS].sort());
});
