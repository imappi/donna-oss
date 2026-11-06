import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const apiSource = read('../../server/donna/api.js');
const consoleSource = read('../components/FirmOpsConsole.jsx');
const workspaceSource = read('../components/financials/financial-report-workspace.jsx');
const reportsSource = read('../components/donna-client-reports.jsx');

test('both venture and firm chat routes persist ledger-hydrated financial actions', () => {
  assert.match(apiSource, /import \{ hydrateFinancialReportActions \} from '\.\/financialReportChat\.js';/);
  assert.equal(apiSource.match(/const hydratedActions = await hydrateFinancialReportActions\(\{/g)?.length, 2);
  assert.equal(apiSource.match(/actions: hydratedActions,/g)?.length, 2);
  assert.match(apiSource, /resolveLatestPeriod: getLatestPostedLedgerPeriodFromDb/);
  assert.match(apiSource, /latestPeriodByClient\.get\(actionClientId\)/);
});

test('the firm report is a transient canvas over the shared report endpoint, not a new destination', () => {
  assert.match(consoleSource, /artifact\?\.type === 'financials'/);
  assert.match(consoleSource, /<FinancialReportWorkspace/);
  assert.match(consoleSource, /onClose=\{\(\) => setArtifact\(null\)\}/);
  assert.match(workspaceSource, /showSupportingStatements/);
  assert.match(workspaceSource, /key=\{`\$\{artifact\?\.data\?\.clientId \|\| ''\}:\$\{period \|\| 'latest'\}`\}/);
  assert.match(reportsSource, /fetchFinancialReport\(\{/);
  assert.match(reportsSource, /const canonicalRequest = \{ clientId, periodStart, periodEnd, basis, format \};/);
  assert.match(reportsSource, /downloadFinancialReport\(canonicalRequest\)/);
  assert.match(reportsSource, /const reportAnchorDate =/);
});
