import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFinancialReportCsv,
  buildFinancialReportPdf,
  financialReportFilename
} from './financialReportExport.js';
import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'report-export-pins';
const CLIENT_ID = 'owner-export-client';
const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-01-31';
const auth = { authorization: `Bearer ${TOKEN}` };

const reportUrl = (format) =>
  `/api/donna/firms/reports/financial-statements?client_id=${CLIENT_ID}`
  + `&period_start=${PERIOD_START}&period_end=${PERIOD_END}&format=${format}`;

const routePool = () => createApiSeamPool([
  [/select id from clients where firm_id = \$1 and id = \$2 and status/, {
    rows: [{ id: CLIENT_ID, firm_id: 'donna-demo-firm', status: 'active' }],
    rowCount: 1
  }]
]);

const assertReportReadsRan = (pool) => {
  assert.equal(pool.matching(/from ledger_accounts/).length, 1, 'account read must run');
  assert.equal(pool.matching(/from ledger_journals/).length, 1, 'journal read must run');
  assert.equal(pool.matching(/from ledger_lines ll/).length, 1, 'ledger-line read must run');
  assert.equal(pool.matching(/from transactions/).length, 1, 'transaction read must run');
  assert.equal(pool.matching(/from documents/).length, 2, 'statement-document and sales-recognition reads must run');
  assert.equal(pool.matching(/document_type = 'sales_invoice'/).length, 1, 'FI-09 sales-recognition census read must run');
  assert.equal(pool.matching(/from transaction_review_queue/).length, 1, 'review read must run');
  assert.equal(pool.matching(/from close_periods/).length, 1, 'close-period read must run');
};

await test('financial report route exports CSV with its canonical download filename', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = routePool();

  const response = await requestDonnaApi({ url: reportUrl('csv'), headers: auth, pool });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['content-type'], 'text/csv; charset=utf-8');
  const expectedReport = {
    client_id: CLIENT_ID,
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    draft: { is_draft: true }
  };
  assert.equal(
    response.headers['content-disposition'],
    `attachment; filename="${financialReportFilename(expectedReport, 'csv')}"`
  );
  assert.match(response.body, /^Donna financial statements\n/);
  assertReportReadsRan(pool);
});

await test('financial report route exports a non-empty PDF response', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = routePool();

  const response = await requestDonnaApi({ url: reportUrl('pdf'), headers: auth, pool });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['content-type'], 'application/pdf');
  assert.ok(response.body.length > 0);
  assertReportReadsRan(pool);
});

await test('financial report route currently treats an unknown format as JSON', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = routePool();

  const response = await requestDonnaApi({ url: reportUrl('xlsx'), headers: auth, pool });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['content-type'], 'application/json');
  assert.equal(response.json.client_id, CLIENT_ID);
  assert.equal(response.json.period_start, PERIOD_START);
  assert.equal(response.json.period_end, PERIOD_END);
  assertReportReadsRan(pool);
});

await test('financial report route refuses an unauthenticated download before report reads', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = routePool();

  const response = await requestDonnaApi({ url: reportUrl('csv'), pool });

  assert.equal(response.statusCode, 401, response.body);
  assert.deepEqual(response.json, { code: 'AUTH_REQUIRED', error: 'Access token required.' });
  assert.equal(pool.queries.length, 0, 'authentication must fail before any database read');
});

const fixtureReport = {
  firm_id: 'fixture-firm',
  client_id: 'fixture-client',
  period_start: '2026-04-01',
  period_end: '2026-04-30',
  as_of: '2026-04-30',
  basis: 'accrual',
  currency: { presentation: 'GBP', currencies: ['GBP'], mixed: false },
  draft: { is_draft: false, stamp: 'FINAL', reasons: [] },
  profit_and_loss: {
    accounts: [{
      code: '4000', name: 'Sales, "online"\nand retail', account_type: 'revenue',
      currency: 'GBP', revenue: 1234.567, expense: 0, net: 1234.567
    }],
    revenue: 1234.567, expenses: 12.345, net_income: 1222.222
  },
  balance_sheet: {
    assets: { accounts: [] }, liabilities: { accounts: [] }, equity: { accounts: [] },
    total_assets: 10.005, total_liabilities: 0, total_equity: 10.005,
    total_liabilities_and_equity: 10.005, balanced: true
  },
  trial_balance: {
    accounts: [{
      code: '4000', name: 'Sales, "online"\nand retail', account_type: 'revenue',
      currency: 'GBP', debit_balance: 0, credit_balance: 1234.567
    }],
    total_debit: 1234.567, total_credit: 1234.567, balanced: true
  }
};

await test('CSV builder pins headers, RFC-style name escaping, and money formatting', () => {
  const csv = buildFinancialReportCsv(fixtureReport);

  assert.ok(csv.includes('Account code,Account name,Type,Currency,Revenue,Expense,Net'));
  assert.ok(csv.includes('Section,Account code,Account name,Currency,Amount,Unclassified'));
  assert.ok(csv.includes('Account code,Account name,Type,Currency,Debit,Credit'));
  assert.ok(csv.includes('4000,"Sales, ""online""\nand retail",revenue,GBP,1234.57,0.00,1234.57'));
  assert.ok(csv.includes(',Net income,,,,,1222.22'));
  assert.ok(csv.includes('Total assets,,,,10.01,'));
  assert.ok(csv.includes('4000,"Sales, ""online""\nand retail",revenue,GBP,0.00,1234.57'));
});

await test('CSV builder pins the complete empty-report shape', () => {
  assert.equal(buildFinancialReportCsv({}), [
    'Donna financial statements', 'Source,Donna posted ledger', 'Firm,', 'Client,',
    'Period, to ', 'As of,', 'Basis,accrual', 'Currency,', 'Status,FINAL', '',
    'Profit and Loss ( to )', 'Account code,Account name,Type,Currency,Revenue,Expense,Net',
    ',Total revenue,,,0.00,,', ',Total expenses,,,,0.00,', ',Net income,,,,,0.00', '',
    'Balance Sheet (as of )', 'Section,Account code,Account name,Currency,Amount,Unclassified',
    'Total assets,,,,0.00,', 'Total liabilities,,,,0.00,', 'Total equity,,,,0.00,',
    'Total liabilities and equity,,,,0.00,', 'Balance sheet foots (A = L + E),,,,NO,',
    'Imbalance,,,,0.00,', '', 'Trial Balance',
    'Account code,Account name,Type,Currency,Debit,Credit', ',Total,,,0.00,0.00',
    ',Balanced,,,NO,', ''
  ].join('\n'));
});

await test('PDF builder emits non-empty PDF bytes', async () => {
  const bytes = await buildFinancialReportPdf(fixtureReport);

  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 0);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
});
