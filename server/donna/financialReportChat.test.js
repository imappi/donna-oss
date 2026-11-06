import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFinancialReportActionSummary,
  financialReportPeriodBounds,
  hydrateFinancialReportActions
} from './financialReportChat.js';
import { getLatestPostedLedgerPeriodFromDb } from './firmDb.js';

const REPORT = {
  period_start: '2025-08-01',
  period_end: '2025-08-31',
  basis: 'accrual',
  currency: { presentation: 'USD', currencies: ['USD'], mixed: false },
  profit_and_loss: {
    revenue: 0,
    expenses: 826.05,
    net_income: -826.05,
    accounts: [
      { name: 'Insurance', account_label: 'Insurance', section: 'expense', expense: 280.8 },
      { name: 'Operating supplies', account_label: 'Operating supplies', section: 'expense', expense: 480.39 },
      { name: 'Marketing', account_label: 'Marketing', section: 'expense', expense: 15.51 }
    ]
  },
  cash: { total: -2823.52 },
  draft: {
    is_draft: true,
    period_closed: false,
    stamp: 'DRAFT',
    reasons: [
      { code: 'unclassified_accounts', detail: '2 accounts not yet classified (460.17).', count: 2, amount: 460.17 },
      { code: 'unposted_transactions', detail: '10 transactions not yet posted to the ledger.', count: 10 }
    ]
  }
};

test('month bounds include leap years and reject malformed periods', () => {
  assert.deepEqual(financialReportPeriodBounds('2024-02'), {
    periodStart: '2024-02-01',
    periodEnd: '2024-02-29'
  });
  assert.equal(financialReportPeriodBounds('2024-13'), null);
});

test('the chat summary is an exact projection of report figures and draft reasons', () => {
  const summary = buildFinancialReportActionSummary(REPORT);
  assert.deepEqual(summary.profit_and_loss, { revenue: 0, expenses: 826.05, net_income: -826.05 });
  assert.deepEqual(summary.cash, { total: -2823.52 });
  assert.equal(summary.top_drivers[0].account_label, 'Operating supplies');
  assert.equal(summary.top_drivers[0].amount, 480.39);
  assert.deepEqual(summary.draft.reasons, REPORT.draft.reasons);
});

test('firm-Inbox hydration keeps the action venture and resolves latest from posted-ledger period', async () => {
  const calls = [];
  const [action, untouched] = await hydrateFinancialReportActions({
    actions: [
      { type: 'open_financials', client_id: 'honeybee', client_name: 'Honeybee Hills Apiary LLC', period: null },
      { type: 'diagnose', client_id: 'cactus', transaction_ids: ['tx-1'] }
    ],
    firmId: 'firm-1',
    resolveLatestPeriod: async ({ clientId }) => {
      assert.equal(clientId, 'honeybee');
      return '2025-08';
    },
    loadReport: async (request) => {
      calls.push(request);
      return REPORT;
    }
  });
  assert.equal(action.client_id, 'honeybee');
  assert.equal(action.period, '2025-08');
  assert.equal(action.financial_summary.profit_and_loss.net_income, -826.05);
  assert.deepEqual(calls, [{
    firmId: 'firm-1',
    clientId: 'honeybee',
    periodStart: '2025-08-01',
    periodEnd: '2025-08-31',
    basis: 'accrual'
  }]);
  assert.equal(untouched.type, 'diagnose');
  assert.equal(untouched.financial_summary, undefined);
});

test('latest financial period query reads only posted journals and keeps DATE formatting in SQL', async () => {
  let observed = null;
  const period = await getLatestPostedLedgerPeriodFromDb({
    firmId: 'firm-1',
    clientId: 'honeybee',
    query: async (sql, params) => {
      observed = { sql, params };
      return { rows: [{ period: '2025-08' }] };
    }
  });
  assert.equal(period, '2025-08');
  assert.match(observed.sql, /max\(journal_date\)/);
  assert.match(observed.sql, /status = 'posted'/);
  assert.match(observed.sql, /to_char\(max\(journal_date\), 'YYYY-MM'\)/);
  assert.deepEqual(observed.params, ['firm-1', 'honeybee']);
});

test('a latest-period read failure becomes an honest unavailable card instead of failing the chat turn', async () => {
  const [action] = await hydrateFinancialReportActions({
    actions: [{ type: 'open_financials', client_id: 'honeybee', period: null }],
    firmId: 'firm-1',
    resolveLatestPeriod: async () => { throw new Error('temporary read failure'); },
    loadReport: async () => { throw new Error('must not be called'); }
  });
  assert.equal(action.period, null);
  assert.equal(action.financial_summary.available, false);
});
