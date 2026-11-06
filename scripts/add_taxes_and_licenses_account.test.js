import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseArgv,
  hasTaxesAndLicensesAccount,
  pickInsertCode
} from './add_taxes_and_licenses_account.js';

// ── parseArgv ────────────────────────────────────────────────────────

await test('parseArgv: defaults to donna-demo-firm + dry-run + all clients', () => {
  const args = parseArgv([]);
  assert.deepEqual(args, { apply: false, firmId: 'donna-demo-firm', clientId: null });
});

await test('parseArgv: --apply flips dry-run off', () => {
  const args = parseArgv(['--apply']);
  assert.equal(args.apply, true);
});

await test('parseArgv: --firm overrides default firm', () => {
  const args = parseArgv(['--firm', 'other-firm']);
  assert.equal(args.firmId, 'other-firm');
});

await test('parseArgv: --client narrows scope', () => {
  const args = parseArgv(['--client', 'honeybee-hills-apiary']);
  assert.equal(args.clientId, 'honeybee-hills-apiary');
});

await test('parseArgv: all flags combined', () => {
  const args = parseArgv(['--apply', '--firm', 'f1', '--client', 'c1']);
  assert.deepEqual(args, { apply: true, firmId: 'f1', clientId: 'c1' });
});

// ── hasTaxesAndLicensesAccount ───────────────────────────────────────

await test('hasTaxesAndLicensesAccount: false on empty / null', () => {
  assert.equal(hasTaxesAndLicensesAccount([]), false);
  assert.equal(hasTaxesAndLicensesAccount(null), false);
  assert.equal(hasTaxesAndLicensesAccount(undefined), false);
});

await test('hasTaxesAndLicensesAccount: matches "Taxes & Licenses" (ampersand)', () => {
  const accounts = [
    { code: '6115', name: 'Taxes & Licenses', account_type: 'expense' }
  ];
  assert.equal(hasTaxesAndLicensesAccount(accounts), true);
});

await test('hasTaxesAndLicensesAccount: matches "Taxes and Licenses" (word)', () => {
  const accounts = [
    { code: '6115', name: 'Taxes and Licenses', account_type: 'expense' }
  ];
  assert.equal(hasTaxesAndLicensesAccount(accounts), true);
});

await test('hasTaxesAndLicensesAccount: matches lowercase / mixed casing', () => {
  const accounts = [
    { code: '6115', name: 'taxes & licenses', account_type: 'expense' }
  ];
  assert.equal(hasTaxesAndLicensesAccount(accounts), true);
});

await test('hasTaxesAndLicensesAccount: tolerates `name` vs `account_name`', () => {
  const accounts = [
    { code: '6115', account_name: 'Taxes & Licenses', account_type: 'expense' }
  ];
  assert.equal(hasTaxesAndLicensesAccount(accounts), true);
});

await test('hasTaxesAndLicensesAccount: rejects "Sales Tax Payable" (no "license" stem)', () => {
  const accounts = [
    { code: '2100', name: 'Sales Tax Payable', account_type: 'liability' }
  ];
  assert.equal(hasTaxesAndLicensesAccount(accounts), false);
});

await test('hasTaxesAndLicensesAccount: rejects "Property Tax" (no "license" stem)', () => {
  const accounts = [
    { code: '6110', name: 'Property Tax', account_type: 'expense' }
  ];
  assert.equal(hasTaxesAndLicensesAccount(accounts), false);
});

await test('hasTaxesAndLicensesAccount: rejects "Software Licenses" (no "tax" stem)', () => {
  const accounts = [
    { code: '6120', name: 'Software Licenses', account_type: 'expense' }
  ];
  assert.equal(hasTaxesAndLicensesAccount(accounts), false);
});

await test('hasTaxesAndLicensesAccount: rejects non-expense type even if name matches', () => {
  // Defensive: if some chart parked a "Taxes & Licenses" row under a
  // non-expense type, treat it as not-present so the backfill inserts
  // the proper expense row.
  const accounts = [
    { code: '6115', name: 'Taxes & Licenses', account_type: 'liability' }
  ];
  assert.equal(hasTaxesAndLicensesAccount(accounts), false);
});

// ── pickInsertCode ───────────────────────────────────────────────────

await test('pickInsertCode: returns first candidate when none taken', () => {
  assert.equal(pickInsertCode([]), '6115');
});

await test('pickInsertCode: skips to next free when preferred is taken', () => {
  assert.equal(pickInsertCode(['6115']), '6116');
  assert.equal(pickInsertCode(['6115', '6116']), '6117');
});

await test('pickInsertCode: returns null when every candidate is occupied', () => {
  const allTaken = ['6115', '6116', '6117', '6118', '6119', '6300', '6301'];
  assert.equal(pickInsertCode(allTaken), null);
});

await test('pickInsertCode: tolerates numeric existing codes', () => {
  assert.equal(pickInsertCode([6115, 6116]), '6117');
});

await test('pickInsertCode: ignores unrelated codes', () => {
  assert.equal(pickInsertCode(['1000', '5000', '6110', '6120']), '6115');
});
