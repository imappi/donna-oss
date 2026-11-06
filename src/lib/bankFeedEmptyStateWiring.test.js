import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const financialsSource = readFileSync(
  new URL('../components/financials/donna-financials-panel.jsx', import.meta.url),
  'utf8'
);
const catalogSource = readFileSync(new URL('../i18n/catalogs/en.js', import.meta.url), 'utf8');

const emptyStateSource = financialsSource.slice(
  financialsSource.indexOf('function FinancialsEmptyState'),
  financialsSource.indexOf('// ── Reconcile panel')
);

test('Bank Feed empty states stay inside the shared list system', () => {
  assert.match(emptyStateSource, /style=\{BANK_FEED_EMPTY_STYLE\}/);
  assert.match(emptyStateSource, /financial\.empty\.reconcile\.title/);
  assert.match(emptyStateSource, /financial\.empty\.reconcile\.body/);
  assert.match(catalogSource, /'financial\.empty\.reconcile\.title': 'No bank lines yet\.'/);
  assert.match(catalogSource, /'financial\.empty\.reconcile\.body': 'Upload a statement to begin\.'/);
  assert.doesNotMatch(emptyStateSource, /dashed|T\.serif|textTransform|eyebrow/);
});

test('the stacked Reconciled section does not add a second explanatory empty state', () => {
  assert.doesNotMatch(financialsSource, /Auto-matched and accepted rows land here\./);
  assert.match(financialsSource, /<FeedSectionHeading label="Reconciled" count=\{totalCount\} \/>/);
});
