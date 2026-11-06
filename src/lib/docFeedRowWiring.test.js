// Doc-anchored Open rows (two-surface IA record §4, precondition P2;
// Kari 2026-08-26: "those solo documents belong to the Open group in that
// list view"). Source-level wiring pins, same pattern as the sibling
// bank-feed wiring tests: a parsed document with no bank line renders as an
// ORDINARY row in its accounting month — shared row grammar, counted in that
// period's Donna lane — never a banner section, and never a
// silent disappearance when the Documents tab folds away.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const financialsSource = readFileSync(
  new URL('../components/financials/donna-financials-panel.jsx', import.meta.url),
  'utf8'
);

test('DocFeedRow speaks the shared bank-feed row grammar', () => {
  const rowSource = financialsSource.slice(
    financialsSource.indexOf('function DocFeedRow'),
    financialsSource.indexOf('function ReconcilePanel')
  );
  assert.ok(rowSource.length > 0, 'DocFeedRow exists ahead of ReconcilePanel');
  // The shared list system, not a bespoke card: row class, row style, the
  // date/primary/amount/trailing columns, and a keyboard-nav row id.
  assert.match(rowSource, /className="bank-feed-list-row"/);
  assert.match(rowSource, /data-bank-feed-list-row="true"/);
  assert.match(rowSource, /data-bank-feed-row-id=\{`open:doc:\$\{row\.id\}`\}/);
  assert.match(rowSource, /BANK_FEED_ROW_STYLE/);
  assert.match(rowSource, /BANK_FEED_DATE_STYLE/);
  assert.match(rowSource, /BANK_FEED_PRIMARY_STYLE/);
  assert.match(rowSource, /BANK_FEED_AMOUNT_STYLE/);
  assert.match(rowSource, /BANK_FEED_TRAILING_CELL_STYLE/);
  // No banner/explainer resurrection — the 2026-08-03 "noise" shape.
  assert.doesNotMatch(rowSource, /Parsed · no terminal yet/);
});

test('doc rows render inside their period stream with a state pill', () => {
  // Single-list amendment (Kari, 2026-08-31): no lane headings — the doc row
  // renders from the month's ONE date-sorted stream. State-pill amendment
  // (2026-09-01): the trailing pill is the row's state from the shared
  // classifier (blocked source ⇒ Stalled, otherwise Processing); the
  // specific document status moves to the hover title and the aria-label.
  assert.match(
    financialsSource,
    /if \(entry\.lane === 'document'\) \{\s*const row = entry\.row;\s*return \(\s*<DocFeedRow/
  );
  // Verdict-first pills (2026-09-23): a Processing pill names the row's own
  // phase from the projection receipt, and one summary line per live upload
  // batch is mounted above the periods.
  assert.match(financialsSource, /<StreamStatePill state=\{streamEntryState\('document', row\)\} phase=\{streamEntryPhase\('document', row\)\} title=\{statusLabel\} \/>/);
  assert.match(financialsSource, /phase=\{streamEntryPhase\(lane, row\)\}/);
  assert.match(financialsSource, /activityBatchSummaries\(\[\.\.\.transactions, \.\.\.documents\]\)[\s\S]*\{activityBatches\.map\(\(summary\) => \([\s\S]*\{displayPeriods\.map\(/);
  // The selection stays the machine-checked, source-aware documentsInbox helper —
  // the panel must not grow its own matching logic or bypass source aggregation.
  assert.match(
    financialsSource,
    /selectMaterialOpenDocumentRows\(\{\s*documents,\s*transactions,\s*reconciliationMatches,\s*reviewItems,\s*clientEvidenceRequests\s*\}\)/
  );
  // The parked banner section and its flag are gone (two terminal states
  // for a render flag: unconditional or deleted).
  assert.doesNotMatch(financialsSource, /SHOW_UNMATCHED_DOCS_ON_RECONCILE/);
  assert.doesNotMatch(financialsSource, /UnmatchedDocumentsSection/);
});

test('doc-anchored rows are passed once into the pure period projection', () => {
  assert.match(financialsSource, /documentRows: unmatchedDocRows/);
  assert.doesNotMatch(financialsSource, /unmatchedDocCount/);
});

test('completed no-settlement document row shows the scoped assessment and visible incomplete accounting label', async () => {
  const en=(await import('../i18n/catalogs/en.js')).default;
  assert.equal(en['lifecycle.noSettlementInScope'],'No bank line in supplied scope');
  assert.equal(en['lifecycle.accountingIncomplete'],'Accounting incomplete');
  const rowSource=financialsSource.slice(financialsSource.indexOf('function DocFeedRow'),financialsSource.indexOf('function ReconcilePanel'));
  assert.match(rowSource,/const scopedNoSettlement = streamEntryState\('document', row\) === 'no_settlement'/);
  assert.match(rowSource,/id: scopedNoSettlement \? 'lifecycle.noSettlementInScope'/);
  assert.match(rowSource,/scopedNoSettlement && <span[\s\S]*?lifecycle.accountingIncomplete/);
  assert.match(financialsSource,/no_settlement: \{ labelId: 'lifecycle.noSettlementInScope'/);
});


test('long scoped status wraps inside its own column and retains full accessible wording', () => {
  const pill=financialsSource.slice(financialsSource.indexOf('function StreamStatePill'),financialsSource.indexOf('export const GbStatutoryRows'));
  assert.match(pill,/\['no_settlement', 'review_only'\]\.includes\(state\)/);
  assert.match(pill,/minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', whiteSpace: 'normal'/);
  assert.match(pill,/overflowWrap: 'anywhere'/);
  assert.match(pill,/<span title=\{title\}/);
  assert.match(pill,/intl.formatMessage\(\{ id: meta.labelId \}\)/);
});
