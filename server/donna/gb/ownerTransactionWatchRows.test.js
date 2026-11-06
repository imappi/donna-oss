import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGbOwnerTransactionWatchRows,
  deriveGbOwnerWatchBalances
} from './ownerTransactionWatchRows.js';

const dlaRow = (debit, credit) => ({
  canonical_role: 'liability.director_loan', account_type: 'liability',
  debit_total: debit, credit_total: credit
});

test('balances derive by canonical role and account type with the documented signs', () => {
  const { dlaBalance, ownerEquityBalance } = deriveGbOwnerWatchBalances({ rows: [
    dlaRow(12000, 2000),
    { canonical_role: 'equity.owner_capital', account_type: 'equity', debit_total: 0, credit_total: 5000 },
    { canonical_role: 'equity.owner_drawings', account_type: 'equity', debit_total: 8000, credit_total: 0 },
    { canonical_role: 'revenue.sales', account_type: 'revenue', debit_total: 0, credit_total: 4000 },
    { canonical_role: null, account_type: 'expense', debit_total: 2500, credit_total: 0 },
    // Asset/liability rows never touch the equity side; a non-DLA liability
    // never touches the DLA side.
    { canonical_role: 'asset.cash', account_type: 'bank', debit_total: 99999, credit_total: 0 },
    { canonical_role: 'liability.tax_payable', account_type: 'liability', debit_total: 0, credit_total: 7000 }
  ] });
  assert.equal(dlaBalance, 10000);
  assert.equal(ownerEquityBalance, 5000 - 8000 + 4000 - 2500);
});

test('an overdrawn DLA past the beneficial-loan threshold renders both attention rows', () => {
  const rows = buildGbOwnerTransactionWatchRows({ entityAxis: 'ltd', balanceRows: [dlaRow(12000, 1000)] });
  assert.deepEqual(rows, [
    { key: 'dla_s455', label: "Director's loan account", due_date: null, terminal: 'on_owner', reason_code: 'GB_DLA_S455_ATTENTION' },
    { key: 'dla_beneficial_loan', label: "Director's loan account", due_date: null, terminal: 'on_owner', reason_code: 'GB_DLA_BENEFICIAL_LOAN_ATTENTION' }
  ]);
});

test('a modest overdrawn DLA renders s455 attention only', () => {
  const rows = buildGbOwnerTransactionWatchRows({ entityAxis: 'ltd', balanceRows: [dlaRow(3000, 500)] });
  assert.deepEqual(rows.map(({ reason_code }) => reason_code), ['GB_DLA_S455_ATTENTION']);
});

test('a credit-balance DLA (company owes the director) renders no rows', () => {
  assert.deepEqual(buildGbOwnerTransactionWatchRows({ entityAxis: 'ltd', balanceRows: [dlaRow(1000, 6000)] }), []);
});

test('sole-trader drawings beyond capital plus earnings render the advisory row', () => {
  const rows = buildGbOwnerTransactionWatchRows({ entityAxis: 'sole_trader', balanceRows: [
    { canonical_role: 'equity.owner_capital', account_type: 'equity', debit_total: 0, credit_total: 1000 },
    { canonical_role: 'equity.owner_drawings', account_type: 'equity', debit_total: 5000, credit_total: 0 },
    { canonical_role: 'revenue.sales', account_type: 'revenue', debit_total: 0, credit_total: 2000 }
  ] });
  assert.deepEqual(rows, [
    { key: 'owner_equity', label: 'Owner equity', due_date: null, terminal: 'on_owner', reason_code: 'GB_ST_NEGATIVE_OWNER_EQUITY_ATTENTION' }
  ]);
});

test('a profitable sole-trader book with heavy drawings stays silent — earnings count', () => {
  const rows = buildGbOwnerTransactionWatchRows({ entityAxis: 'sole_trader', balanceRows: [
    { canonical_role: 'equity.owner_drawings', account_type: 'equity', debit_total: 5000, credit_total: 0 },
    { canonical_role: 'revenue.sales', account_type: 'revenue', debit_total: 0, credit_total: 9000 },
    { canonical_role: null, account_type: 'expense', debit_total: 1000, credit_total: 0 }
  ] });
  assert.deepEqual(rows, []);
});

test('an axis that fits neither table renders nothing', () => {
  assert.deepEqual(buildGbOwnerTransactionWatchRows({ entityAxis: 'llp', balanceRows: [dlaRow(9999, 0)] }), []);
  assert.deepEqual(buildGbOwnerTransactionWatchRows({ entityAxis: null, balanceRows: [dlaRow(9999, 0)] }), []);
});
