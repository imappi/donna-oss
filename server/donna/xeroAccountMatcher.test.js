import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichCodingWithXeroAccount, resolveXeroAccount } from './xeroAccountMatcher.js';
import { buildDonnaLedgerWriteback } from './donnaLedgerWriteback.js';

const receipt = { money_in: 3.1, money_out: 0 };
const spend = { money_in: 0, money_out: 12 };

// Donna's own chart: an uncoded palette book with Sales and Office expenses,
// and a coded row that answers to a palette alias.
const donnaChart = [
  { code: null, name: 'Sales', type: 'revenue', status: 'active', source: 'native_ledger' },
  { code: null, name: 'Office expenses', type: 'expense', status: 'active', source: 'native_ledger' },
  { code: '9300', name: 'Korkotuotot', type: 'revenue', status: 'active', source: 'native_ledger', aliases: ['Interest income'] }
];
const post = (account, transaction) => buildDonnaLedgerWriteback({
  transaction: { id: 't', ...transaction, proposed_account: account, account_name: account, category: account, ai_suggestion: { proposed_account: account } },
  ledgerAccounts: donnaChart,
  jurisdiction: 'fi'
}).coding;

test("Donna's own chart: a coded account resolves by code, name or alias, never onto a neighbour", () => {
  assert.equal(post('Sales', receipt).xero_account_name, 'Sales');
  assert.equal(post('9300', receipt).xero_account_name, 'Korkotuotot');
  assert.equal(post('Interest income', receipt).xero_account_code, '9300');
  for (const [account, transaction] of [['Other income', receipt], ['Other revenue', receipt], ['Software subscriptions', spend], ['Office supplies', spend]]) {
    const coding = post(account, transaction);
    assert.equal(coding.xero_account_match_status, 'unmatched', account);
    assert.ok(!coding.xero_account_name, account);
    assert.equal(coding.account_name, account, `${account} keeps its own name, to mint`);
  }
});

test('the exact-only rule covers alternatives too', () => {
  const coding = enrichCodingWithXeroAccount({ coding: { proposed_account: 'Sales', alternatives: [{ account: 'Other income' }] },
    transaction: receipt, xeroAccounts: donnaChart, substitute: false });
  assert.deepEqual(coding.alternatives, [{ account: 'Other income' }]);
});

// An external chart keeps its curated name mapping.
const xeroChart = [
  { code: '200', name: 'Sales', type: 'REVENUE', status: 'ACTIVE' },
  { code: '260', name: 'Other Revenue', type: 'REVENUE', status: 'ACTIVE' },
  { code: '270', name: 'Interest Income', type: 'REVENUE', status: 'ACTIVE' },
  { code: '485', name: 'Subscriptions', type: 'EXPENSE', status: 'ACTIVE' }
];
const onXero = (account, transaction = receipt) => resolveXeroAccount({ account, transaction, xeroAccounts: xeroChart })?.name || null;

test('external chart: named income maps to its own bucket, not to Sales', () => {
  assert.equal(onXero('Other income'), 'Other Revenue');
  assert.equal(onXero('Other revenue'), 'Other Revenue');
  assert.equal(onXero('Interest income'), 'Interest Income');
  assert.equal(onXero('Sales income'), 'Sales');
  assert.equal(onXero('Revenue'), 'Sales');
  assert.equal(onXero('Software subscriptions', spend), 'Subscriptions');
});

test('external chart without an other-income bucket leaves Other income unmatched', () => {
  const chart = xeroChart.filter((row) => row.code !== '260');
  assert.equal(resolveXeroAccount({ account: 'Other income', transaction: receipt, xeroAccounts: chart }), null);
});
